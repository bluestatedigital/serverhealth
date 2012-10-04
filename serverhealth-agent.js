#!/usr/local/bin/node

var udp = require('dgram'),
    sys = require('util'),
    exec = require('child_process').exec,
    fs = require('fs');

var node = process.argv.shift();
var file = process.argv.shift();
var configFile = process.argv.shift();

process.argv.unshift(file);
process.argv.unshift(node);

// Grab our configuration, load it, and update the hostname if need be.
var config = require(configFile).config;

// Some synchronization primitives to make coalescing multiple async callbacks
// a weeee bit easier.
var runningTasks = 0;

function taskStarted(command) { runningTasks++; }
function taskFinished(command) { runningTasks--; }
function tasksRunning() { return runningTasks > 0; }
function whenTasksComplete(callback) {
    // Polling every 10ms seems to be speedy enough and doesn't hurt us
    // performance wise.
    setTimeout(function() {
        if(tasksRunning()) {
            setTimeout(function() {
                whenTasksComplete(callback);
            }, 10);
        } else {
            callback();
        }
    }, 10);
}

function makeWrappedExecCall(command, successHandler, errorHandler) {
    // If we didn't get an error handler, just spit the error to console.
    if(typeof errorHandler == 'undefined') {
        errorHandler = function(err) { sys.log(err); };
    }

    taskStarted(command);

    exec(command, function (e, sio, se) {
        if(typeof se != 'undefined' && se.length > 0) {
            errorHandler(se);
            taskFinished(command);
        } else {
            successHandler(sio);
            taskFinished(command);
        }
    });
}

function makeWrappedFileRead(path, successHandler, errorHandler) {
    // If we didn't get an error handler, just spit the error to console.
    if(typeof errorHandler == 'undefined') {
        errorHandler = function(err) { sys.log(err); };
    }

    taskStarted();

    fs.readFile(path, function(err, data) {
        if(err) {
            errorHandler(err);
            taskFinished();
        } else {
            successHandler(data);
            taskFinished();
        }
    });
}

function getHostname() {
    sys.log("Getting our hostname...");

    // Try and get our hostname.
    makeWrappedExecCall("hostname --short",
        function(data) {
            var hostname = data.replace(/[\s\r\n]+$/, '');
            config.hostname = hostname;
        },
        function() {
            // We got back an error... which probably means we simply couldn't
            // get a short name.  This happens sometimes, no biggie.
            makeWrappedExecCall("hostname",
                function(data) {
                    // Nailed it!
                    var hostname = data.replace(/[\s\r\n]+$/, '');
                    config.hostname = hostname;
                },
                function(err) {
                    // Well this sucks.  Print the error and let's exit.
                    sys.log(err);

                    process.exit(1);
                }
            );
        }
    );
}

function getCpuCoreCount() {
    sys.log("Getting our core count...");
}

function sendNodeData(nodeData)
{
    var nodeDataJson = JSON.stringify(nodeData);
    var payload = new Buffer(nodeDataJson.toString('utf8'));

    var client = udp.createSocket('udp4');
    client.send(payload, 0, payload.length, config.collectorPort, config.collectorHost, function() {
        client.close();
    });
}

function run() {
    var nodeInfo = { name: config.hostname };

    makeWrappedExecCall("vmstat 1 2", function(data) {
        var vmstatSplit = data.split("\n");

        var statLine = vmstatSplit[3]
            .replace("\t", ' ')
            .replace(/ +/g, ' ')
            .replace(/^\s+|\s+$/g, '')
            .split(' ');
        var cpuIdleTime = statLine[14];

        nodeInfo.cpuUsage = (100 - cpuIdleTime);
    });

    // Now get our load averages.
    makeWrappedFileRead("/proc/loadavg", function(data) {
        if(typeof data != 'undefined' && data.length > 0) {
            var uptimeSplit = data
                .toString('ascii')
                .replace("\t", ' ')
                .replace(/ +/g, ' ')
                .replace(/^\s+|\s+$/g, '')
                .split(' ');

            var oneMinLoadAvg = uptimeSplit[0].replace(',', '');
            var fiveMinLoadAvg = uptimeSplit[1].replace(',', '');
            var fifteenMinLoadAvg = uptimeSplit[2].replace(',', '');

            nodeInfo.loadAvg = {
                oneMinute: oneMinLoadAvg,
                fiveMinutes: fiveMinLoadAvg,
                fifteenMinutes: fifteenMinLoadAvg
            }
        }
    });

    // Now get our memory numbers.
    makeWrappedFileRead("/proc/meminfo", function(data) {
        if(typeof data != 'undefined' && data.length > 0) {
            var memoryInfoSplit = data
                .toString('ascii')
                .split("\n");

            var memoryTotal = memoryInfoSplit[0]
                .replace('kB', '')
                .replace(/ +/g, ' ')
                .replace(/^\s+|\s+$/g, '')
                .split(' ');

            var memoryFree = memoryInfoSplit[1]
                .replace('kB', '')
                .replace(/ +/g, ' ')
                .replace(/^\s+|\s+$/g, '')
                .split(' ');

            nodeInfo.memoryUsage = {
                memoryTotal: memoryTotal[1],
                memoryFree: memoryFree[1]
            }
        }
    });

    // Wait for our tasks to finish.
    whenTasksComplete(function() {
        // We're good - send our data.
        sendNodeData(nodeInfo);

        // Schedule our next run.
        process.nextTick(function() {
            run();
        });
    });
}

sys.log("Starting ServerHealth agent...");

// Get the system's hostname.
if(!config.hostname) {
    getHostname();
}

// See how many cores we have.
getCpuCoreCount();

// Wait for running tasks to finish before starting the agent.
whenTasksComplete(function() {
    sys.log("Starting main loop...");

    // Start the agent!
    run();
});
