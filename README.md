# Steam for Node.js

[![npm version](https://img.shields.io/npm/v/steam-client.svg)](https://npmjs.com/package/steam-client)
[![npm downloads](https://img.shields.io/npm/dm/steam-client.svg)](https://npmjs.com/package/steam-client)
[![dependencies](https://img.shields.io/david/DoctorMcKay/node-steam-client.svg)](https://david-dm.org/DoctorMcKay/node-steam-client)
[![license](https://img.shields.io/npm/l/steam-client.svg)](https://github.com/DoctorMcKay/node-steam-client/blob/master/LICENSE)
[![paypal](https://img.shields.io/badge/paypal-donate-yellow.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=N36YVAT42CZ4G&item_name=node%2dsteam%2dclient&currency_code=USD)

This is a fork of [node-steam](https://www.npmjs.com/package/steam)'s SteamClient. Essentially it's node-steam without
the handler modules and with some more features. It should be compatible with all node-steam handler modules, as long
as the underlying Steam protocol doesn't change without a third-party module's knowledge.

This exists because of how painfully slow it is to get new things implemented into node-steam, and also because of
incompatibilities that can potentially arise between node-steam and third-party handler modules.

Protocol version bumps will always be major module releases. You're highly recommended to pin the major version in your
dependencies (e.g. `"steam-client": "^1.0.0"`).

**Requires Node.js v4.1.1 or later.**

# Installation

    $ npm install steam-client

# Usage

First, `require` this module.
```js
var Steam = require('steam-client');
```
`Steam` is now a namespace object containing:
* [CMClient class](#cmclient)
* [`servers` property](#servers)
* [Enums](#enums)

Then you'll want to create an instance of CMClient and any handlers you need (externally), call
[SteamClient#connect](#connect) and assign event listeners. Some handlers, such as
[`node-steam-user`](https://www.npmjs.com/package/steam-user) do this automatically for you.

```js
var client = new Steam.CMClient();
client.connect();
client.on('connected', function() {
    // log on or something
});
```

# Constructor

The constructor takes one argument: the protocol to use to connect to Steam. This should be a value from
[`EConnectionProtocol`](https://github.com/DoctorMcKay/node-steam-client/blob/master/index.js#L25).
Default is TCP. **UDP support is experimental.** There are some pros and cons to each:

- TCP
    - **Pro:** Operating system manages the connection, so you will automatically disconnect if your app crashes or is killed
    - **Con:** Less fine control over the connection. It's up to the OS to detect poor network conditions and kill the connection
- UDP
    - **Pro:** Finer control over the connection. Able to tear down a broken connection faster in cases where the OS wouldn't detect it
    - **Pro:** Gives you access to the server load of the CM you connected to
    - **Con:** If your app crashes or is killed without properly logging off or disconnecting, your session will remain active for a minute while Steam waits for it to timeout
    - **Con:** Currently support for UDP connections in `CMClient` is experimental

Note that UDP connections use Valve-brand UDP, which is essentially TCP over UDP. Consequently, network unreliability
is not a concern when using UDP.

Example:

```js
var Steam = require('steam-client');
var client = new Steam.CMClient(Steam.EConnectionProtocol.TCP);
```

# Servers

`Steam.servers` contains the list of CM servers that `CMClient` will attempt to connect to. During module install, an
attempt to retrieve the current server list is made, but if that fails we fall back to the one in this repo which is not
always up-to-date and might contain dead servers. To avoid timeouts, replace it with your own list before logging in if
you have one (see ['servers' event](#servers-1)).

# SteamID

Since JavaScript's Number type does not have enough precision to store 64-bit integers, SteamIDs are represented as decimal strings. (Just wrap the number in quotes)

# Enums

Whenever a method accepts (or an event provides) an `ESomething`, it's a Number that represents some enum value. See
[enums.steamd](https://github.com/SteamRE/SteamKit/blob/master/Resources/SteamLanguage/enums.steamd) and
[eresult.steamd](https://github.com/SteamRE/SteamKit/blob/master/Resources/SteamLanguage/eresult.steamd) for the whole
list of them. For each enum, there is an equivalently named property on `Steam`. The property is an object; for each of
the enum's members, there is an equivalently named property on the object with an equivalent value.

Note that you can't easily get the string value from the number, but you probably don't need to. You can still use them
in conditions (e.g. `if (type == Steam.EChatEntryType.Emote) ...`) or switch statements.

# Protobufs

Whenever a method accepts (or an event provides) a `CMsgSomething`, it's an object that represents a protobuf message.
It has an equivalently named property for each set field in the specified message with the type as follows:

* `(u)int32` and `fixed32` fields: Number
* `uint64`, `fixed64` and `string` fields: String
* `bytes` fields: Buffer objects
* `bool` fields: Boolean

See the [node-steam wiki](https://github.com/seishun/node-steam/wiki/Protobufs) for descriptions of protobuf fields.

# Handlers

Most of the API is provided by handler classes that internally send and receive low-level client messages using
['message'/send](#messagesend).

This module has no handlers built-in. You may use handlers from [`node-steam`](https://www.npmjs.com/package/steam), or
you may alternatively use standalone handlers (such as [`node-steam-user`](https://www.npmjs.com/package/steam-user)).

# CMClient

## Properties

### connected

A boolean that indicates whether you are currently connected and the encryption handshake is complete.
['connected'](#connected-1) is emitted when it changes to `true`, and ['error'](#error) is emitted when it changes to
`false` unless you called [disconnect](#disconnect). Sending any client messages is only allowed while this is `true`.

### loggedOn

A boolean that indicates whether you are currently logged on. This must be `true` for all messages types except those
used in this module and logon message types.

It is initially set to `false`.

### steamID

A string representing the logged on users' SteamID.

It is initially set to `null`.

### remoteAddress

**v2.1.0 or later is required to use this property**

If we've initiated a connection previously, a string containing "ipv4:port" for the server we're connecting/connected to.
Also contains the address of the last host we were connected to if we're currently disconnected.

## Methods

### bind([localAddress][, localPort])
- `localAddress` - The local IP address you want to use for the outgoing connection
- `localPort` - The local port you want to use for the outgoing connection

Override the address and/or port that will be used for the outgoing connection. Takes effect the next time you connect.

### connect([server][, autoRetry])
- `server` - If you want to connect to a specific CM server, provide an object here containing `host` and `port` properties. Default is a random value from the [`servers`](#servers) property.
- `autoRetry` - `true` if you want to automatically retry connection until successful, or `false` if you want an `error` event if connection fails. Default `true`.

Connects to Steam. It will keep trying to reconnect (provided `autoRetry` is not `false`) until encryption handshake is
complete (see ['connected'](#connected-1)), unless you cancel it with [disconnect](#disconnect).

You can call this method at any time. If you are already connected, disconnects you first. If there is an ongoing
connection attempt, cancels it.

### disconnect()

Immediately terminates the connection and prevents any events (including ['error'](#error)) from being emitted until
you [connect](#connect) again. If you are already disconnected, does nothing. If there is an ongoing connection
attempt, cancels it.

### send(header, body, callback)
- `header` - An object containing the message header. It has the following properties:
    - `msg` - A value from `EMsg`
    - `proto` - A [`CMsgProtoBufHeader`](https://github.com/SteamRE/SteamKit/blob/master/Resources/Protobufs/steamclient/steammessages_base.proto) object if this message is protobuf-backed, otherwise `header.proto` is falsy. The following fields are reserved for internal use and shall be ignored: `steamid`, `client_sessionid`, `jobid_source`, `jobid_target`. (Note: pass an empty object if you don't need to set any fields)
- `body` - A `Buffer` or `ByteBuffer` containing the rest of the message
- `callback` (optional) - if not falsy, then this message is a request, and `callback` shall be called with any response to it instead of 'message'/send. `callback` has the same arguments as 'message'/send.

## Events

### error
- `err` - An `Error` object. May contain an `eresult` property.

 - Connection closed by the server. Only emitted if the encryption handshake is complete, otherwise it will reconnect
automatically (unless you disabled `autoRetry`). [`loggedOn`](#loggedon) is now `false`.

### connected
- `serverLoad` - The load value of the CM server you're connected to. Only available if you're connecting using UDP. It's unclear at this time what scale this value uses.

Encryption handshake complete. From now on, it's your responsibility to handle disconnections and reconnect
(see [`error`](#error)).

### servers
- `servers` - An array containing the up-to-date server list

CMClient will use this new list when reconnecting, but it will be lost when your application restarts. You might want
to save it to a file or a database and assign it to [`Steam.servers`](#servers) before logging in next time.

Note that `Steam.servers` will be automatically updated *after* this event is emitted. This will be useful if you want
to compare the old list with the new one for some reason - otherwise it shouldn't matter.

### message
- `header` - An object containing the message header
- `body` - A `Buffer` containing the rest of the message
- `callback` - If set, then this message is a request and Steam expects a response back from you. To respond, call this callback instead of using `send()`.

Emitted when you receive a message from the CM.
