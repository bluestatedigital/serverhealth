#!/usr/local/bin/node

var udp = require('dgram'),
    sys = require('util'),
    exec = require('child_process').exec;

var node = process.argv.shift();
var file = process.argv.shift();
var configFile = process.argv.shift();

process.argv.unshift(file);
process.argv.unshift(node);

// Grab our configuration, load it, and update the hostname if need be.
var config = require(configFile).config;
if (!config.hostname) {
    // We have no hostname, so call 'hostname --short' to grab it.
    exec("hostname --short", function (e, sio, se) {
        if(typeof sio != 'undefined' && sio.length > 0) {
            var hostname = sio.replace(/[\s\r\n]+$/, '');
            config.hostname = hostname;
        }

        if(typeof se != 'undefined' && se.length > 0) {
            sys.log('[err] ' + se);
        }
    });
}

// Define our main loop.  We call vmstat, get our stuff, then we build an object
// to send to our collector which is then passed off to listening clients.  We do
// this over UDP so we can avoid dealing with ugly error handling and network
// problems.  The collector and clients are set up to deal with data loss so we
// concentrate on simply pushing out stats when possible. :)
function run(config, exec, udp, sys) {
    exec("vmstat 1 2", function(e, sio, se) {
        if(typeof sio != 'undefined'  && sio.length > 0) {
            var vmstatSplit = sio.split("\n");

            var statLine = vmstatSplit[3]
                .replace("\t", ' ')
                .replace(/ +/g, ' ')
                .replace(/^\s+|\s+$/g, '')
                .split(' ');
            var cpuIdleTime = statLine[14];

            // Now get our load averages.
            exec("uptime", function(e2, sio2, se2) {
                if(typeof sio2 != 'undefined'  && sio2.length > 0) {

                    var uptimeSplit = sio2
                        .replace("\t", ' ')
                        .replace(/ +/g, ' ')
                        .replace(/^\s+|\s+$/g, '')
                        .split(' ');

                    var oneMinLoadAvg = uptimeSplit[9].replace(',', '');
                    var fiveMinLoadAvg = uptimeSplit[10].replace(',', '');
                    var fifteenMinLoadAvg = uptimeSplit[11].replace(',', '');

                    var nodeInfo = {
                        name: config.hostname,
                        cpuUsage: (100 - cpuIdleTime),
                        loadAvg: {
                            oneMinute: oneMinLoadAvg,
                            fiveMinutes: fiveMinLoadAvg,
                            fifteenMinutes: fifteenMinLoadAvg
                        }
                    };

                    var nodeInfoString = JSON.stringify(nodeInfo);

                    sys.log(nodeInfoString);

                    var payload = new Buffer(nodeInfoString.toString('utf8'));

                    var client = udp.createSocket('udp4');
                    client.send(payload, 0, payload.length, config.collectorPort, config.collectorHost, function() {
                        sys.log('Sent health payload to ' + config.collectorHost + ':' + config.collectorPort);
                        client.close();
                    });
                }

                if(typeof se2 != 'undefined' && se2.length > 0) {
                    sys.log('[err] ' + se2);
                }
            });
        }

        if(typeof se != 'undefined' && se.length > 0) {
            sys.log('[err] ' + se);
        }

        process.nextTick(function() {
            run(config, exec, udp, sys);
        });
    });
}

// Start le agent.
sys.log("Starting serverhealth...");
run(config, exec, udp, sys);
