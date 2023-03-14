'use strict';

// In enable() function, we do these things:
//   1. create an indicator and add it the Main.panel,
//   2. connect to kanata, read from it asynchronously and update the indicator,
//   3. subscribe the kanata starting signal and do step 2 when receiving it.

const { Clutter, GLib, Gio, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const Me = ExtensionUtils.getCurrentExtension();
const { Button } = imports.ui.panelMenu;

class Extension {
    constructor() {
        this._hostAndPort = null;
        this._connection = null;
        this._inputStream = null;
        this._cancellable = null;
        this._textDecoder = null;
        this._label = null;
        this._indicator = null;
        this._dbusConnection = null;
        this._handlerId = null;
        this._isConnected = false;
        this._dbusGetStateParams = null;
        this._settings = null;
    }

    enable() {
        console.log(`enabling ${Me.metadata.name}`);

        [this._label, this._indicator] = this._createIndicator();
        try {
            Main.panel.addToStatusArea(Me.metadata.uuid, this._indicator);
        } catch (e) {
            console.error(
                `failed to add kanata indicator to Main.panel: ${e.message}`
            );
            return;
        }

        this._textDecoder = new TextDecoder();
        this._cancellable = new Gio.Cancellable();
        this._dbusGetStateParams = new GLib.Variant('(ss)', [
            'org.freedesktop.systemd1.Unit',
            'ActiveState',
        ]);

        this._settings = ExtensionUtils.getSettings(
            'org.gnome.shell.extensions.kanata'
        );

        const host = this._settings.get_string('host');
        const port = this._settings.get_uint('port');
        this._hostAndPort = `${host}:${port}`;
        this._connectAndUpdateLayer(
            this._hostAndPort,
            this._cancellable,
            this._textDecoder,
            this._label,
            this._indicator
        );

        try {
            // TODO do we REALLY need to make it asynchronous?
            this._dbusConnection = Gio.DBus.system;
        } catch (e) {
            console.error(
                `skip subscribing kanata starting signal because we failed to get dbus connection: ${e.message}`
            );
            return;
        }
        const dbusName = this._settings.get_string('dbus-name');
        const serviceName = this._settings.get_string('service-name');
        this._handlerId = this._reconnectWhenNeeded(
            this._dbusConnection,
            this._hostAndPort,
            this._cancellable,
            this._textDecoder,
            this._label,
            this._indicator,
            this._dbusGetStateParams,
            dbusName,
            serviceName
        );
    }

    // unlock-dialog is included in session-modes because the kanata layer can
    // affect the way users input their password to unlock the session.
    disable() {
        console.log(`disabling ${Me.metadata.name}`);

        if (this._indicator) {
            this._indicator.destroy();
        }
        this._indicator = null;
        this._label = null;

        if (this._isConnected && this._cancellable) {
            this._cancellable.cancel();
            console.log('cancel read');
        }
        this._cancellable = null;

        this._disconnect();

        this._hostAndPort = null;
        this._textDecoder = null;

        if (this._dbusConnection) {
            this._dbusConnection.signal_unsubscribe(this._handlerId);
        }
        this._dbusConnection = null;
        this._handlerId = null;

        this._dbusGetStateParams = null;

        this._settings = null;
    }

    _createIndicator() {
        const label = new St.Label({
            text: 'init...',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const indicator = new Button(0.0, '', false);
        indicator.add_child(label);
        indicator.hide();
        return [label, indicator];
    }

    _connectAndUpdateLayer(
        hostAndPort,
        cancellable,
        textDecoder,
        label,
        indicator
    ) {
        try {
            [this._connection, this._inputStream] = this._connect(hostAndPort);
        } catch (e) {
            console.error(`failed to connect to kanata: ${e.message}`);
            return;
        }
        this._updateLayer(
            this._inputStream,
            cancellable,
            textDecoder,
            label,
            indicator,
            hostAndPort
        );
    }

    _connect(hostAndPort) {
        // TODO do we REALLY need to make it asynchronous?
        const connection = new Gio.SocketClient().connect_to_host(
            hostAndPort,
            null,
            null
        );
        this._isConnected = true;
        const inputStream = connection.get_input_stream();
        return [connection, inputStream];
    }

    _disconnect(hostAndPort) {
        if (this._connection) {
            try {
                this._connection.close(null);
            } catch (e) {
                console.warn(
                    `failed to close connection to kanata ${hostAndPort}: ${e.message}`
                );
            }
        }
        this._isConnected = false;
        this._connection = null;
        this._inputStream = null;
    }

    _hideIndicatorAndDisconnect(indicator, label, hostAndPort, logFun, reason) {
        indicator.hide();
        label.set_text('disconnected');

        this._disconnect(hostAndPort);

        logFun(`hide indicator and close connection because ${reason}`);
    }

    _updateLayer(
        inputStream,
        cancellable,
        textDecoder,
        label,
        indicator,
        hostAndPort
    ) {
        inputStream.read_bytes_async(
            1024,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (stream, result) => {
                let bytes = null;
                try {
                    bytes = stream.read_bytes_finish(result);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        // this error is thrown when this._cancellable.cancel()
                        // is called in this.disable(), so no need to call
                        // this._disconnect() here
                        console.log(
                            `async read to kanata ${hostAndPort} is cancelled`
                        );
                    } else {
                        this._hideIndicatorAndDisconnect(
                            indicator,
                            label,
                            hostAndPort,
                            console.error,
                            `unexpected error happened when async reading from kanata ${hostAndPort}: ${e.message}`
                        );
                    }
                    return;
                }
                const array = bytes.toArray();
                // TODO find a better to check that tcp connection is closed by the remote peer
                // these all fail to do so for kanata server
                //   - this._connection.is_closed()
                //   - this._connection.is_connected()
                //   - this._inputStream.is_closed()
                // SO answers[1][2] suggest checking if it reads 0 byte
                // [1]: https://stackoverflow.com/a/16592841
                // [2]: https://stackoverflow.com/a/65534535
                if (array.length === 0) {
                    this._hideIndicatorAndDisconnect(
                        indicator,
                        label,
                        hostAndPort,
                        console.log,
                        `connection has been closed by kanata server ${hostAndPort}`
                    );
                    return;
                }
                const string = textDecoder.decode(array);
                try {
                    const layer = JSON.parse(string).LayerChange?.new;
                    if (layer === undefined) {
                        throw new SyntaxError('missing LayerChange.new');
                    }

                    label.set_text(layer);
                    // show() after set_text() to avoid label flashing
                    if (!indicator.is_visible()) {
                        indicator.show();
                    }
                } catch (e) {
                    if (e instanceof SyntaxError) {
                        console.warn(
                            `ignore invalid input from kanata ${hostAndPort}: ${e.message}`
                        );
                    } else {
                        console.warn(
                            `ignore unexpected error when parsing input from kanata ${hostAndPort}: ${e.message}`
                        );
                    }
                }

                this._updateLayer(
                    inputStream,
                    cancellable,
                    textDecoder,
                    label,
                    indicator,
                    hostAndPort
                );
            }
        );
    }

    _getKanataState(dbusConnection, dbusGetStateParams, dbusName) {
        return new Promise((resolve, reject) => {
            dbusConnection.call(
                'org.freedesktop.systemd1',
                `/org/freedesktop/systemd1/unit/${dbusName}`,
                'org.freedesktop.DBus.Properties',
                'Get',
                dbusGetStateParams,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (connection, result) => {
                    try {
                        const reply = connection.call_finish(result);
                        const value = reply.deepUnpack()[0];
                        const state = value.get_string()[0];
                        resolve(state);
                    } catch (e) {
                        if (e instanceof Gio.DBusError) {
                            Gio.DBusError.strip_remote_error(e);
                        }
                        reject(e);
                    }
                }
            );
        });
    }

    _reconnectWhenNeeded(
        dbusConnection,
        hostAndPort,
        cancellable,
        textDecoder,
        label,
        indicator,
        dbusGetStateParams,
        dbusName,
        serviceName
    ) {
        return dbusConnection.signal_subscribe(
            'org.freedesktop.systemd1',
            'org.freedesktop.systemd1.Manager',
            'JobRemoved',
            '/org/freedesktop/systemd1',
            null,
            Gio.DBusSignalFlags.NONE,
            // connection, sender, path, iface, signal, params
            async (...[, , , , , params]) => {
                // doc says this does not throw errors
                // https://gjs-docs.gnome.org/gjs/overrides.md#glib-variant-deepunpack
                const [, , name, result] = params.deepUnpack();

                // avoid unneeded calls to this._getKanataState()
                if (!(result === 'done' && name === serviceName)) {
                    return;
                }

                let state = null;
                try {
                    state = await this._getKanataState(
                        dbusConnection,
                        dbusGetStateParams,
                        dbusName
                    );
                } catch (e) {
                    console.warn(
                        `failed to get kanata state using dbus: ${e.message}`
                    );
                }
                if (state === 'active') {
                    console.log(`kanata server ${hostAndPort} just started`);
                    // kanata takes 2s to start, so this is almost always true
                    if (!this._isConnected) {
                        console.log(
                            `re-connect to kanata server ${hostAndPort}`
                        );
                        this._connectAndUpdateLayer(
                            hostAndPort,
                            cancellable,
                            textDecoder,
                            label,
                            indicator
                        );
                    } else {
                        console.warn(
                            'this should never happen: the previous connection should be closed (by server) now, but it is still open'
                        );
                    }
                }
            }
        );
    }
}

function init(meta) {
    console.log(`initializing ${meta.metadata.name}`);
    return new Extension();
}

// Local Variables:
// eval: (indent-tabs-mode -1)
// End:
