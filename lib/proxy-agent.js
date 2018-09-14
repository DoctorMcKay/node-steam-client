const HTTP = require('http');
const HTTPS = require('https');
const TLS = require('tls');
const URL = require('url');

/**
 * Get an Agent that connects through a proxy.
 * @param {boolean} secure - Will the connection to the destination server be secure? NOT the connection to the proxy.
 * @param {string|null} proxyUrl - The URL of the proxy, including the protocol, auth (if applicable), host, and port
 * @param {int} [proxyTimeout=5000] - Timeout for connecting to the proxy, in milliseconds
 * @returns {*}
 */
exports.getAgent = function(secure, proxyUrl, proxyTimeout) {
	if (!proxyUrl) {
		return false; // no need to use an agent
	}

	var agent = new (secure ? HTTPS : HTTP).Agent({"keepAlive": false});
	agent.createConnection = function(options, callback) {
		var url = URL.parse(proxyUrl);
		var prox = {};
		for (var i in url) {
			if (url.hasOwnProperty(i)) {
				prox[i] = url[i];
			}
		}

		prox.method = 'CONNECT';
		prox.path = options.host + ':' + options.port; // the host where we want the proxy to connect
		prox.localAddress = options.localAddress;
		prox.localPort = options.localPort;
		if (prox.auth) {
			prox.headers = {
				"Proxy-Authorization": "Basic " + (new Buffer(prox.auth, 'utf8')).toString('base64')
			};
			delete prox.auth;
		}

		// Make the CONNECT request
		var finished = false;
		var didWeEverConnect = false;
		var req = (prox.protocol == "https:" ? HTTPS : HTTP).request(prox);
		req.end();
		req.setTimeout(proxyTimeout || 5000);

		req.on('connect', (res, socket) => {
			didWeEverConnect = true;

			if (finished) {
				// This has already errored
				socket.end();
				return;
			}

			finished = true;
			req.setTimeout(0);

			if (res.statusCode != 200) {
				callback(new Error("Proxy CONNECT " + res.statusCode + " " + res.statusMessage));
				return;
			}

			if (!secure) {
				// The connection to the destination server won't be secure, so we're done here
				callback(null, socket);
				return;
			}

			var tlsOptions = {"socket": socket};
			for (var i in options) {
				if (!options.hasOwnProperty(i)) {
					continue;
				}

				if (i.match(/^_/) || ['agent', 'headers'].indexOf(i) != -1) {
					// Ignore private properties, and "agent" and "headers"
					continue;
				}

				tlsOptions[i] = options[i];
			}

			// The connection to the destination server needs to be secure, so do the TLS handshake with the destination
			var tlsSocket = TLS.connect(tlsOptions, () => {
				tlsSocket.removeListener('error', onTlsError); // we don't want to intercept errors later on

				if (!tlsSocket.authorized && tlsOptions.rejectUnauthorized !== false) {
					// Checking this isn't strictly necessary as all versions of Node since 2013 won't call this callback in this case
					// (or perhaps all versions of node ever that have TLSSocket?)
					callback(new Error(tlsSocket.authorizationError || "Secure connection failed"));
					return;
				}

				// All good!
				callback(null, tlsSocket);
			});

			tlsSocket.on('error', onTlsError);
			function onTlsError(err) {
				// TLS handshake error
				socket.end();
				err.proxyConnecting = !didWeEverConnect;
				callback(err);
			}
		});

		req.on('timeout', () => {
			if (finished) {
				return;
			}

			finished = true;
			var err = new Error("Proxy connection timed out");
			err.proxyConnecting = !didWeEverConnect;
			callback(err);
		});

		req.on('error', (err) => {
			if (finished) {
				return;
			}

			finished = true;
			err.proxyConnecting = !didWeEverConnect;
			callback(err);
		});
	};

	return agent;
};
