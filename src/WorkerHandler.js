"use strict";

var Promise = require("./Promise");
var environment = require("./environment");
var requireFoolWebpack = require("./requireFoolWebpack");

/**
 * Special message sent by parent which causes a child process worker to terminate itself.
 * Not a "message object"; this string is the entire message.
 */
var TERMINATE_METHOD_ID = "__workerpool-terminate__";

/**
 * If sending `TERMINATE_METHOD_ID` does not cause the child process to exit in this many milliseconds,
 * force-kill the child process.
 */
var CHILD_PROCESS_EXIT_TIMEOUT = 1000;

function ensureWorkerThreads() {
  var WorkerThreads = tryRequireWorkerThreads();
  if (!WorkerThreads) {
    throw new Error(
      "WorkerPool: workerType = 'thread' is not supported, Node >= 11.7.0 required"
    );
  }

  return WorkerThreads;
}

// check whether Worker is supported by the browser
function ensureWebWorker() {
  // Workaround for a bug in PhantomJS (Or QtWebkit): https://github.com/ariya/phantomjs/issues/14534
  if (
    typeof Worker !== "function" &&
    (typeof Worker !== "object" ||
      typeof Worker.prototype.constructor !== "function")
  ) {
    throw new Error("WorkerPool: Web Workers not supported");
  }
}

function tryRequireWorkerThreads() {
  try {
    return requireFoolWebpack("worker_threads");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      error.code === "MODULE_NOT_FOUND"
    ) {
      // no worker_threads available (old version of node.js)
      return null;
    } else {
      throw error;
    }
  }
}

// get the default worker script
function getDefaultWorker() {
  if (environment.platform === "browser") {
    // test whether the browser supports all features that we need
    if (typeof Blob === "undefined") {
      throw new Error("Blob not supported by the browser");
    }
    if (!window.URL || typeof window.URL.createObjectURL !== "function") {
      throw new Error("URL.createObjectURL not supported by the browser");
    }

    // use embedded worker.js
    var blob = new Blob([require("./generated/embeddedWorker")], {
      type: "text/javascript",
    });
    return window.URL.createObjectURL(blob);
  } else {
    // use external worker.js in current directory
    return __dirname + "/worker.js";
  }
}

function setupWorker(script, options) {
  if (options.workerType === "web") {
    // browser only
    ensureWebWorker();
    return setupBrowserWorker(script, Worker);
  } else if (options.workerType === "thread") {
    // node.js only
    WorkerThreads = ensureWorkerThreads();
    return setupWorkerThreadWorker(
      script,
      WorkerThreads,
      options.workerThreadOpts
    );
  } else if (options.workerType === "process" || !options.workerType) {
    // node.js only
    return setupProcessWorker(
      script,
      resolveForkOptions(options),
      requireFoolWebpack("child_process")
    );
  } else {
    // options.workerType === 'auto' or undefined
    if (environment.platform === "browser") {
      ensureWebWorker();
      return setupBrowserWorker(script, Worker);
    } else {
      // environment.platform === 'node'
      var WorkerThreads = tryRequireWorkerThreads();
      if (WorkerThreads) {
        return setupWorkerThreadWorker(
          script,
          WorkerThreads,
          options.workerThreadOpts
        );
      } else {
        return setupProcessWorker(
          script,
          resolveForkOptions(options),
          requireFoolWebpack("child_process")
        );
      }
    }
  }
}

function setupBrowserWorker(script, Worker) {
  // create the web worker
  var worker = new Worker(script);

  worker.isBrowserWorker = true;
  // add node.js API to the web worker
  worker.on = function (event, callback) {
    this.addEventListener(event, function (message) {
      callback(message.data);
    });
  };
  worker.send = function (message) {
    this.postMessage(message);
  };
  return worker;
}

function setupWorkerThreadWorker(script, WorkerThreads, workerThreadOptions) {
  var worker = new WorkerThreads.Worker(script, {
    stdout: false, // automatically pipe worker.STDOUT to process.STDOUT
    stderr: false, // automatically pipe worker.STDERR to process.STDERR
    ...workerThreadOptions,
  });
  worker.isWorkerThread = true;
  // make the worker mimic a child_process
  worker.send = function (message) {
    this.postMessage(message);
  };

  worker.kill = function () {
    this.terminate();
    return true;
  };

  worker.disconnect = function () {
    this.terminate();
  };

  return worker;
}

function setupProcessWorker(script, options, child_process) {
  // no WorkerThreads, fallback to sub-process based workers
  var worker = child_process.fork(script, options.forkArgs, options.forkOpts);

  worker.isChildProcess = true;
  return worker;
}

// add debug flags to child processes if the node inspector is active
function resolveForkOptions(opts) {
  opts = opts || {};

  var processExecArgv = process.execArgv.join(" ");
  var inspectorActive = processExecArgv.indexOf("--inspect") !== -1;
  var debugBrk = processExecArgv.indexOf("--debug-brk") !== -1;

  var execArgv = [];
  if (inspectorActive) {
    execArgv.push("--inspect=" + opts.debugPort);

    if (debugBrk) {
      execArgv.push("--debug-brk");
    }
  }

  process.execArgv.forEach(function (arg) {
    if (arg.indexOf("--max-old-space-size") > -1) {
      execArgv.push(arg);
    }
  });

  return Object.assign({}, opts, {
    forkArgs: opts.forkArgs,
    forkOpts: Object.assign({}, opts.forkOpts, {
      execArgv: ((opts.forkOpts && opts.forkOpts.execArgv) || []).concat(
        execArgv
      ),
    }),
  });
}

/**
 * Converts a serialized error to Error
 * @param {Object} obj Error that has been serialized and parsed to object
 * @return {Error} The equivalent Error.
 */
function objectToError(obj) {
  if (typeof obj === "string") {
    return new Error(obj);
  }
  var temp = new Error("");
  var props = Object.keys(obj);

  for (var i = 0; i < props.length; i++) {
    temp[props[i]] = obj[props[i]];
  }

  return temp;
}

/**
 * A WorkerHandler controls a single worker. This worker can be a child process
 * on node.js or a WebWorker in a browser environment.
 * @param {String} [script] If no script is provided, a default worker with a
 *                          function run will be created.
 * @param {WorkerPoolOptions} _options See docs
 * @constructor
 */
function WorkerHandler(script, _options) {
  var me = this;
  var options = _options || {};

  this.script = script || getDefaultWorker();
  this.worker = setupWorker(this.script, options);
  this.debugPort = options.debugPort;
  this.forkOpts = options.forkOpts;
  this.forkArgs = options.forkArgs;
  this.workerThreadOpts = options.workerThreadOpts;
  this.concurrency = options.concurrency ? options.concurrency : 1;
  this.requestCount = 0;
  this.responseCount = 0;
  this.maxExec = options.maxExec || 0;
  this.totalTime = 0;
  this.minTime = Infinity;
  this.maxTime = 0;
  this.lastTime = 0;
  this.markNotReadyAfterExec = options.markNotReadyAfterExec || false;
  this.readyTimeoutDuration = options.readyTimeoutDuration;
  this.initReadyTimeoutDuration =
    options.initReadyTimeoutDuration == null
      ? this.readyTimeoutDuration
      : options.initReadyTimeoutDuration;

  let _onWorkerExit = options.onWorkerExit;
  this.onWorkerExit = function () {
    if (_onWorkerExit) {
      _onWorkerExit();
    }
    _onWorkerExit = null;
  };

  let _onWorkerReady = options.onWorkerReady;
  this.onWorkerReady = function () {
    if (_onWorkerReady) {
      _onWorkerReady();
    }
  };

  this.setReadyTimeout = function (timeoutDuration) {
    me.clearReadyTimeout();
    if (!timeoutDuration) {
      return;
    }
    me.readyTimeoutTimer = setTimeout(() => {
      me.terminate();
    }, timeoutDuration);
  };
  this.clearReadyTimeout = function () {
    if (!me.readyTimeoutTimer) {
      return;
    }
    clearTimeout(me.readyTimeoutTimer);
    delete me.readyTimeoutTimer;
  };

  // Reset stats every hour
  setInterval(() => {
    this.minTime = Infinity;
    this.maxTime = 0;
  }, 1000 * 60 * 5);

  // The ready message is only sent if the worker.add method is called (And the default script is not used)
  if (!script) {
    this.worker.ready = true;
    this.onWorkerReady();
  }

  // queue for requests that are received before the worker is ready
  this.requestQueue = [];
  this.worker.on("message", function (response) {
    if (me.terminated) {
      return;
    }
    if (typeof response === "string" && response === "ready") {
      me.clearReadyTimeout();
      me.worker.ready = true;
      me.onWorkerReady();
      dispatchQueuedRequests();
    } else {
      // find the task from the processing queue, and run the tasks callback
      var id = response.id;
      var task = me.processing[id];
      if (task !== undefined) {
        if (response.isEvent) {
          if (task.options && typeof task.options.on === "function") {
            task.options.on(response.payload);
          }
        } else {
          const opts = me.processing[id];
          const timeSpent = Date.now() - opts.started;

          me.lastTime = timeSpent;
          if (timeSpent > me.maxTime) {
            me.maxTime = timeSpent;
          }
          if (timeSpent < me.minTime) {
            me.minTime = timeSpent;
          }
          me.totalTime += timeSpent;

          me.responseCount++;

          if (me.markNotReadyAfterExec) {
            me.worker.ready = false;
            me.setReadyTimeout(me.readyTimeoutDuration);
          }

          // remove the task from the queue
          delete me.processing[id];

          if (this.maxExec && this.responseCount >= this.maxExec) {
            me.terminating = true;
            me.onWorkerExit();
          }

          // test if we need to terminate
          if (me.terminating === true) {
            // complete worker termination if all tasks are finished
            me.terminate();
          }

          // resolve the task's promise
          if (response.error) {
            task.resolver.reject(objectToError(response.error));
          } else {
            task.resolver.resolve(response.result);
          }
        }
      }
    }
  });

  this.setReadyTimeout(this.initReadyTimeoutDuration);

  // reject all running tasks on worker error
  function onError(error) {
    me.terminated = true;

    for (var id in me.processing) {
      if (me.processing[id] !== undefined) {
        me.processing[id].resolver.reject(error);
      }
    }
    me.processing = Object.create(null);
    me.onWorkerExit();
  }

  // send all queued requests to worker
  function dispatchQueuedRequests() {
    for (const request of me.requestQueue.splice(0)) {
      me.worker.send(request);
    }
  }

  var worker = this.worker;
  // listen for worker messages error and exit
  this.worker.on("error", onError);
  this.worker.on("exit", function (exitCode, signalCode) {
    var message = "Workerpool Worker terminated Unexpectedly\n";

    message += "    exitCode: `" + exitCode + "`\n";
    message += "    signalCode: `" + signalCode + "`\n";

    message += "    workerpool.script: `" + me.script + "`\n";
    message += "    spawnArgs: `" + worker.spawnargs + "`\n";
    message += "    spawnfile: `" + worker.spawnfile + "`\n";

    message += "    stdout: `" + worker.stdout + "`\n";
    message += "    stderr: `" + worker.stderr + "`\n";

    onError(new Error(message));
  });

  this.processing = Object.create(null); // queue with tasks currently in progress

  this.terminating = false;
  this.terminated = false;
  this.terminationHandler = null;
  this.lastId = 0;
}

/**
 * Get a list with methods available on the worker.
 * @return {Promise.<String[], Error>} methods
 */
WorkerHandler.prototype.methods = function () {
  return this.exec("methods");
};

/**
 * Execute a method with given parameters on the worker
 * @param {String} method
 * @param {Array} [params]
 * @param {{resolve: Function, reject: Function}} [resolver]
 * @param {ExecOptions}  [options]
 * @return {Promise.<*, Error>} result
 */
WorkerHandler.prototype.exec = function (method, params, resolver, options) {
  if (!resolver) {
    resolver = Promise.defer();
  }

  // generate a unique id for the task
  var id = ++this.lastId;

  // register a new task as being in progress
  this.processing[id] = {
    id: id,
    resolver: resolver,
    options: options,
    started: Date.now(),
  };
  this.requestCount++;

  // build a JSON-RPC request
  var request = {
    id: id,
    method: method,
    params: params,
  };

  if (this.terminated) {
    resolver.reject(new Error("Worker is terminated"));
  } else if (this.worker.ready) {
    // send the request to the worker
    this.worker.send(request);
  } else {
    this.requestQueue.push(request);
  }

  // on cancellation, force the worker to terminate
  var me = this;
  return resolver.promise.catch(function (error) {
    if (
      error instanceof Promise.CancellationError ||
      error instanceof Promise.TimeoutError
    ) {
      // remove this task from the queue. It is already rejected (hence this
      // catch event), and else it will be rejected again when terminating
      delete me.processing[id];

      // terminate worker
      return me.terminateAndNotify(true).then(
        function () {
          throw error;
        },
        function (err) {
          throw err;
        }
      );
    } else {
      throw error;
    }
  });
};

/**
 * Test whether the worker is working or not
 * @return {boolean} Returns true if the worker is busy
 */
WorkerHandler.prototype.busy = function () {
  return Object.keys(this.processing).length >= this.concurrency;
};

/**
 * Test whether the worker is available to take new tasks
 * @return {boolean} Returns true if the worker is available
 */
WorkerHandler.prototype.available = function () {
  return (
    this.worker &&
    !this.terminated &&
    !this.terminating &&
    this.worker.ready &&
    (!this.maxExec || this.requestCount < this.maxExec) &&
    !this.busy()
  );
};

/**
 * Terminate the worker.
 * @param {boolean} [force=false]   If false (default), the worker is terminated
 *                                  after finishing all tasks currently in
 *                                  progress. If true, the worker will be
 *                                  terminated immediately.
 * @param {function} [callback=null] If provided, will be called when process terminates.
 */
WorkerHandler.prototype.terminate = function (force, callback) {
  var me = this;
  this.clearReadyTimeout();
  if (force) {
    // cancel all tasks in progress
    for (var id in this.processing) {
      if (this.processing[id] !== undefined) {
        this.processing[id].resolver.reject(new Error("Worker terminated"));
      }
    }
    this.processing = Object.create(null);
  }

  if (typeof callback === "function") {
    this.terminationHandler = callback;
  }
  if (!this.busy()) {
    // all tasks are finished. kill the worker
    var cleanup = function (err) {
      me.terminated = true;
      if (me.worker != null && me.worker.removeAllListeners) {
        // removeAllListeners is only available for child_process
        me.worker.removeAllListeners("message");
      }
      me.worker = null;
      me.terminating = false;
      if (me.terminationHandler) {
        me.terminationHandler(err, me);
      } else if (err) {
        throw err;
      }
    };

    if (this.worker) {
      if (typeof this.worker.kill === "function") {
        if (this.worker.killed) {
          cleanup(new Error("worker already killed!"));
          return;
        }

        if (this.worker.isChildProcess) {
          var cleanExitTimeout = setTimeout(function () {
            if (me.worker) {
              me.worker.kill();
            }
          }, CHILD_PROCESS_EXIT_TIMEOUT);

          this.worker.once("exit", function () {
            clearTimeout(cleanExitTimeout);
            if (me.worker) {
              me.worker.killed = true;
            }
            cleanup();
          });

          if (this.worker.ready) {
            this.worker.send(TERMINATE_METHOD_ID);
          } else {
            this.requestQueue.push(TERMINATE_METHOD_ID);
          }
        } else {
          // worker_thread
          this.worker.kill();
          this.worker.killed = true;
          cleanup();
        }
        return;
      } else if (typeof this.worker.terminate === "function") {
        this.worker.terminate(); // web worker
        this.worker.killed = true;
      } else {
        throw new Error("Failed to terminate worker");
      }
    }
    cleanup();
  } else {
    // we can't terminate immediately, there are still tasks being executed
    this.terminating = true;
  }
};

/**
 * Terminate the worker, returning a Promise that resolves when the termination has been done.
 * @param {boolean} [force=false]   If false (default), the worker is terminated
 *                                  after finishing all tasks currently in
 *                                  progress. If true, the worker will be
 *                                  terminated immediately.
 * @param {number} [timeout]        If provided and non-zero, worker termination promise will be rejected
 *                                  after timeout if worker process has not been terminated.
 * @return {Promise.<WorkerHandler, Error>}
 */
WorkerHandler.prototype.terminateAndNotify = function (force, timeout) {
  var resolver = Promise.defer();
  if (timeout) {
    resolver.promise.timeout = timeout;
  }
  this.terminate(force, function (err, worker) {
    if (err) {
      resolver.reject(err);
    } else {
      resolver.resolve(worker);
    }
  });
  return resolver.promise;
};

module.exports = WorkerHandler;
module.exports._tryRequireWorkerThreads = tryRequireWorkerThreads;
module.exports._setupProcessWorker = setupProcessWorker;
module.exports._setupBrowserWorker = setupBrowserWorker;
module.exports._setupWorkerThreadWorker = setupWorkerThreadWorker;
module.exports.ensureWorkerThreads = ensureWorkerThreads;
