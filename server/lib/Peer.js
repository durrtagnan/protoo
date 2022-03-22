const Logger = require('./Logger');
const EnhancedEventEmitter = require('./EnhancedEventEmitter');
const Message = require('./Message');

const logger = new Logger('Peer');

class Peer extends EnhancedEventEmitter
{
	/**
	 * @param {String} peerId
	 * @param {protoo.Transport} transport
	 *
	 * @emits close
	 * @emits {request: protoo.Request, accept: Function, reject: Function} request
	 * @emits {notification: protoo.Notification} notification
	 */
	constructor(peerId, transport, timeout = null)
	{
		super(logger);

		logger.debug('constructor()');

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// Reconnection flag
		// @type {Boolean}
		this._reconnecting = false;

		this._timeout = timeout;
		this._timeoutId = null;
		this._handleTimeout = this._handleTimeout.bind(this);

		// Peer id.
		// @type {String}
		this._id = peerId;

		// Transport.
		// @type {protoo.Transport}
		this._transport = transport;

		this._lastMsgTime = null;

		// Custom data object.
		// // @type {Object}
		this._data = {};

		// Map of pending sent request objects indexed by request id.
		// @type {Map<Number, Object>}
		this._sents = new Map();

		// Handle transport.
		this._handleTransport();
	}

	/**
	 * Peer id
	 *
	 * @returns {String}
	 */
	get id()
	{
		return this._id;
	}

	/**
	 * Whether the Peer is closed.
	 *
	 * @returns {Boolean}
	 */
	get closed()
	{
		return this._closed;
	}

	get lastMsgTime()
	{
		return this._lastMsgTime;
	}

	/**
	 * App custom data.
	 *
	 * @returns {Object}
	 */
	get data()
	{
		return this._data;
	}

	/**
	 * Invalid setter.
	 */
	set data(data) // eslint-disable-line no-unused-vars
	{
		throw new Error('cannot override data object');
	}

	/**
	 * Close this Peer and its Transport.
	 */
	close(code = 4000, reason = 'Normal close by server')
	{
		if (this._closed)
			return;

		logger.debug('close()');

		this._closed = true;

		clearTimeout(this._timeoutId);

		// Close Transport.
		this._transport.close(code, reason);

		// Close every pending sent.
		for (const sent of this._sents.values())
		{
			sent.close();
		}

		// Emit 'close' event.
		this.safeEmit('close', code, reason);
	}

	setNewTransport(transport)
	{
		this._transport.drop();

		// Close every pending sent.
		for (const sent of this._sents.values())
		{
			sent.close();
		}

		this._transport = transport;

		this._handleTransport();
	}

	/**
	 * Send a protoo request to the remote Peer.
	 *
	 * @param {String} method
	 * @param {Object} [data]
	 *
	 * @async
	 * @returns {Object} The response data Object if a success response is received.
	 */
	async request(method, data = undefined)
	{
		if (this._reconnecting)
			return;

		const request = Message.createRequest(method, data);

		this._logger.debug('request() [method:%s, id:%s]', method, request.id);

		// This may throw.
		await this._transport.send(request);

		return new Promise((pResolve, pReject) =>
		{
			const timeout = 2000 * (15 + (0.1 * this._sents.size));
			const sent =
			{
				id      : request.id,
				method  : request.method,
				resolve : (data2) =>
				{
					if (!this._sents.delete(request.id))
						return;

					clearTimeout(sent.timer);
					pResolve(data2);
				},
				reject : (error) =>
				{
					if (!this._sents.delete(request.id))
						return;

					clearTimeout(sent.timer);
					pReject(error);
				},
				timer : setTimeout(() =>
				{
					if (!this._sents.delete(request.id))
						return;

					pReject(new Error('request timeout'));
				}, timeout),
				close : () =>
				{
					clearTimeout(sent.timer);
					pReject(new Error('peer closed'));
				}
			};

			// Add sent stuff to the map.
			this._sents.set(request.id, sent);
		});
	}

	/**
	 * Send a protoo notification to the remote Peer.
	 *
	 * @param {String} method
	 * @param {Object} [data]
	 *
	 * @async
	 */
	async notify(method, data = undefined)
	{
		if (this._reconnecting)
			return;

		const notification = Message.createNotification(method, data);

		this._logger.debug('notify() [method:%s]', method);

		// This may throw.
		await this._transport.send(notification);
	}

	_handleTransport()
	{
		if (this._transport.closed)
		{
			this._closed = true;

			setImmediate(() => this.safeEmit('close', 1006, 'transport already closed'));

			return;
		}

		this._transport.on('close', (code, reason) =>
		{
			if (this._closed)
				return;

			if (code === 4001 || reason === 'Connection dropped by remote peer.') // reconnecting
			{
				this._reconnecting = true;

				return;
			}

			this._closed = true;

			this.safeEmit('close', code, reason);
		});

		this._transport.on('message', (message) =>
		{
			this._lastMsgTime = Date.now();

			if (this._timeout) this._resetTimeout();

			if (message.request)
				this._handleRequest(message);
			else if (message.response)
				this._handleResponse(message);
			else if (message.notification)
				this._handleNotification(message);
		});

		this._transport.on('pong', () =>
		{
			this._lastMsgTime = Date.now();

			if (this._timeout) this._resetTimeout();

			this.safeEmit('pong');
		});
	}

	_handleRequest(request)
	{
		try
		{
			this.emit('request',
				// Request.
				request,
				// accept() function.
				(data) =>
				{
					const response = Message.createSuccessResponse(request, data);

					this._transport.send(response)
						.catch(() => {});
				},
				// reject() function.
				(errorCode, errorReason) =>
				{
					if (errorCode instanceof Error)
					{
						errorReason = errorCode.message;
						errorCode = 500;
					}
					else if (typeof errorCode === 'number' && errorReason instanceof Error)
					{
						errorReason = errorReason.message;
					}

					const response =
						Message.createErrorResponse(request, errorCode, errorReason);

					this._transport.send(response)
						.catch(() => {});
				});
		}
		catch (error)
		{
			const response = Message.createErrorResponse(request, 500, String(error));

			this._transport.send(response)
				.catch(() => {});
		}
	}

	_handleResponse(response)
	{
		const sent = this._sents.get(response.id);

		if (!sent)
		{
			logger.error(
				'received response does not match any sent request [id:%s]', response.id);

			return;
		}

		if (response.ok)
		{
			sent.resolve(response.data);
		}
		else
		{
			const error = new Error(response.errorReason);

			error.code = response.errorCode;
			sent.reject(error);
		}
	}

	_handleNotification(notification)
	{
		this.safeEmit('notification', notification);
	}

	_resetTimeout() {
		clearTimeout(this._timeoutId);

		this._timeoutId = setTimeout(this._handleTimeout, this._timeout);
	}

	_handleTimeout() {
		try
		{
			this._transport.drop();
			this.close(1006, 'Timed out');
		}
		catch (error)
		{
			logger.error('_handlePingTimeout() | error dropping the connection: %s', error);
		}
	}
}

module.exports = Peer;
