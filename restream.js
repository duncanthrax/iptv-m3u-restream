process.chdir(__dirname);

const cluster   = require('cluster');
const Https     = require('https');
const Http      = require('http');
const Url       = require('url');
const { spawn } = require('child_process');

var Channels = [];

const Cfg = require('./restream-cfg.json');
if (!Cfg.extUrl.match(/\/$/)) Cfg.extUrl = Cfg.extUrl + '/';

const logger = function(fac, msg, obj) {
    if (cluster.isMaster) {
        if (obj) console.log(`<master> [${fac}] ${msg}`, obj);
        else     console.log(`<master> [${fac}] ${msg}`);
    }
    else {
        if (obj) console.log(`<${cluster.worker.id}> [${fac}] ${msg}`, obj);
        else     console.log(`<${cluster.worker.id}> [${fac}] ${msg}`);
    }
}

// Simple GET wrapper that follows redirects and does http and https
const GetRequest = function(url, cb) {
    var req = (url.match(/^https/i) ? Https : Http).request(url);

    req.on('response', res => {
        logger('request', `${url}: Code ${res.statusCode} with headers`, res.headers);

        if (res.statusCode > 300 && res.statusCode < 400 && res.headers.location)
            return process.nextTick(function() { GetRequest(res.headers.location, cb) });

        cb(null, req, res);
    });
    req.on('abort', () => {
        logger('request', `Aborted ${url}`);
        cb("aborted", null, null);
    });
    req.on('error', err => {
        logger('request', `Error on ${url}`, err);
        cb(err ? err : "error", null, null);
    });
    req.end();
};

// Wrap above for simple GET body retriever
const GetRequestBody = function(url, cb) {
    GetRequest(url, (err, req, res) =>{
        if (err) return cb(err, null);

        res.setEncoding('utf8');
        var body = '';
        res.on('data', chunk => {
            body += chunk;
        });
        res.on('end', () => {
            cb(null, body);
        });
    });
};

// --------------------------------------------------------------------------------------------
// Master
if (cluster.isMaster) {

    logger('master', `restream master running with PID ${process.pid}`);

    const eachWorker = function(callback) {
        for (const id in cluster.workers) {
            callback(cluster.workers[id]);
        }
    };

    const replenishWorkers = function() {
        while (Object.keys(cluster.workers).length < Cfg.numWorkers) {
            cluster.fork().on('online', () => {
                eachWorker(worker => {
                    worker.send({ type: 'channels', channels: Channels });
                });
            });
        };
    };

    cluster.on('message', (worker, message, handle) => {
        if (message.type == 'streaming')
            eachWorker(wrk => {
                if (wrk.id != worker.id) wrk.send({ type: 'quitStreaming' });
            });
    });

    const loadChannels = function() {

        GetRequestBody(Cfg.m3uSrc, (err, body) => {
            if (err) {
                logger('master', "loadChannels request error, retrying in 60 seconds", err);
                return setTimeout(loadChannels, (60 * 1000));
            };

            var lines = body.split(/[\r\n]+/);
            var numChannels = 0;
            Channels = [];
            while (lines.length) {
                var line = lines.shift();
                if (line.match(/#EXTINF:/) && line.length < 200) {

                    // Blacklists
                    if (Cfg.blacklist.find(item => {
                        var rx = new RegExp(item, 'i');
                        return line.match(rx) ? true : false;
                    })) continue;

                    Channels.push({
                        id    : ++numChannels,
                        extinf: line,
                        url   : lines.shift()
                    });
                }
            }
            logger('master', `loaded channel list with ${Channels.length} channels`);
            replenishWorkers();
            setTimeout(loadChannels, (86400 * 1000));
        });
    };

    cluster.on('exit', (worker, code, signal) => {
        logger('master',`worker ${worker.process.pid} died`);
        process.nextTick(replenishWorkers);
    });

    loadChannels();
}
// --------------------------------------------------------------------------------------------
// Worker
else {

    // True if we're streaming
    var streaming = false;

    cluster.worker.on('message', msg => {
        if (msg.type == 'channels') Channels = msg.channels;
        if (msg.type == 'quitStreaming' && streaming) doShutdown();
    });

    var transcoder = false;

    const doShutdown = function() {
        if (transcoder) transcoder.kill();
        process.exit(0);
    };

    const StreamURL = function(url, clientRes, profile) {

        transcoder = spawn(profile.transcoder, profile.transcoderOpts, { env: profile.transcoderEnv || {} });

        transcoder.stderr.on('data', data => {
            if (Cfg.debug['transcoder']) logger('transcoder', data.toString());
        });

        transcoder.stdout.on('error', function (err) {
            logger('transcoder', "stdout error", err);
            doShutdown();
        });

        transcoder.stderr.on('error', function (err) {
            logger('transcoder', "stderr error", err);
            doShutdown();
        });

        transcoder.stdin.on('error', function (err) {
            logger('transcoder', "stdin error", err);
            doShutdown();
        });

        transcoder.on('error', (err) => {
            logger('transcoder', "error", err);
            doShutdown();
        });

        transcoder.on('close', () => {
            logger('transcoder', "closed IO");
            doShutdown();
        });

        transcoder.on('exit', code => {
            logger('transcoder', "exited with code", code);
            doShutdown();
        });

        logger('streaming', "Streaming URL", url);

        // If client acts up, bomb out.
        clientRes.on('close', err => {
            logger('client', "close");
            doShutdown();
        });
        clientRes.on('error', err => {
            logger('client', "error", err);
            doShutdown();
        });

        // Tell the client we'll be sending entertainment.
        clientRes.writeHead(200, { 'Content-Type': profile.contentType, 'Connection': 'close' });

        // Connect transcoder out to client in
        transcoder.stdout.on('data', transcoderChunk => {
            clientRes.write(transcoderChunk);
        });

        // Retryable server connection
        const connectServer = function() {

            var retryTimeout = false;
            const scheduleRetry = function() {
                if (!retryTimeout) {
                    logger('streaming', "Connection to server lost, reconnecting");
                    retryTimeout = setTimeout(connectServer, 10);
                }
            }

            GetRequest(url, (err, serverReq, serverRes) => {
                // Ignore callbacks about aborted request.
                if (err == "aborted") return;

                // If the server does not like us on sight, bomb out.
                if (err || serverRes.statusCode != 200) doShutdown();

                // Connect server out to transcoder in
                var idleTimeout = false;
                serverRes.on('data', serverChunk => {
                    // If we don't get a follow-up chunk within ten seconds, declare server lame.
                    if (idleTimeout) clearTimeout(idleTimeout);
                    idleTimeout = setTimeout(() => { serverReq.abort() }, 10000);
                    if (!serverReq.aborted) transcoder.stdin.write(serverChunk);
                });

                // On inline server-side errors, schedule a reconnect.
                serverRes.on('end', () => {
                    logger('server', "end");
                    scheduleRetry();
                });
                serverRes.on('aborted', () => {
                    logger('server', "aborted");
                    scheduleRetry();
                });
                serverRes.on('close', () => {
                    logger('server', "close");
                    scheduleRetry();
                });
                serverRes.on('error', (err) => {
                    logger('server', "error", err);
                    scheduleRetry();
                });

                serverReq.on('error', err => {
                    logger('server', "error", err);
                    scheduleRetry();
                });
                serverReq.on('close', () => {
                    logger('server', "error", err);
                    scheduleRetry();
                });
            });
        }

        connectServer();
    };

    // Server instance with URL parsing
    const server = Http.createServer();
    server.on('request', (clientReq, clientRes) => {
        var url = Url.parse(clientReq.url, true);

        // Send channels list as M3U
        if (url.pathname.match(/channels/)) {
            var profile = (url.query && url.query.profile && Cfg.profiles[url.query.profile]) ?
                url.query.profile : "default";

            clientRes.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
            return clientRes.end(
                "#EXTM3U\r\n" + Channels.map(item => {
                    return `${item.extinf}\r\n${Cfg.extUrl}watch?channelId=${item.id}&profile=${profile}`;
                }).join("\r\n"),
                'utf8',
                function() { logger('client', `Sent M3U channel list with ${Channels.length} entries`) }
            );
        }

        // Watch a channel
        WATCH: if (url.query && url.query.channelId && url.pathname.match(/watch/)) {
            var channelId = parseInt(url.query.channelId) - 1;
            var profile   = url.query.profile && Cfg.profiles[url.query.profile] ? url.query.profile : "default";
            if (!Channels[channelId]) break WATCH;

            logger('client', `Requested channel ${channelId} for playback, profile ${profile}`);

            // Close server, we don't want to handle any more requests.
            process.nextTick(function() { server.close() });

            // Tell master we're streaming
            streaming = true;
            process.send({ type: 'streaming' });

            // Delay a bit so that other streaming workers get a chance to quit.
            return setTimeout(function() { StreamURL(Channels[channelId].url, clientRes, Cfg.profiles[profile]) }, 100);
        }

        // No handler for URL
        logger('client', "Unknown URL requested");
        clientRes.writeHead(404);
        clientRes.end("Not found");
    });

    server.on('error', err => {
        logger('self', "error", err);
        doShutdown();
    });

    server.on('clientError', (err, socket) => {
        logger('client', "error", err);
        doShutdown();
    });

    server.listen(Cfg.port);
};
