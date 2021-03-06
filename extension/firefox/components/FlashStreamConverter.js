/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil; tab-width: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
 * Copyright 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var EXPORTED_SYMBOLS = ['FlashStreamConverter1', 'FlashStreamConverter2'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

// True only if this is the version of pdf.js that is included with firefox.
const SHUMWAY_CONTENT_TYPE = 'application/x-shockwave-flash';
const EXPECTED_PLAYPREVIEW_URI_PREFIX = 'data:application/x-moz-playpreview;,' +
                                        SHUMWAY_CONTENT_TYPE;

const FIREFOX_ID = '{ec8030f7-c20a-464f-9b0e-13a3a9e97384}';
const SEAMONKEY_ID = '{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}';

const MAX_CLIPBOARD_DATA_SIZE = 8000;

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/NetUtil.jsm');


let appInfo = Cc['@mozilla.org/xre/app-info;1'].getService(Ci.nsIXULAppInfo);
let Svc = {};
XPCOMUtils.defineLazyServiceGetter(Svc, 'mime',
                                   '@mozilla.org/mime;1', 'nsIMIMEService');

function getBoolPref(pref, def) {
  try {
    return Services.prefs.getBoolPref(pref);
  } catch (ex) {
    return def;
  }
}

function getStringPref(pref, def) {
  try {
    return Services.prefs.getComplexValue(pref, Ci.nsISupportsString).data;
  } catch (ex) {
    return def;
  }
}

function log(aMsg) {
  let msg = 'FlashStreamConverter.js: ' + (aMsg.join ? aMsg.join('') : aMsg);
  Services.console.logStringMessage(msg);
  dump(msg + '\n');
}

function getDOMWindow(aChannel) {
  var requestor = aChannel.notificationCallbacks;
  var win = requestor.getInterface(Components.interfaces.nsIDOMWindow);
  return win;
}

function parseQueryString(qs) {
  if (!qs)
    return {};

  if (qs.charAt(0) == '?')
    qs = qs.slice(1);

  var values = qs.split('&');
  var obj = {};
  for (var i = 0; i < values.length; i++) {
    var kv = values[i].split('=');
    var key = kv[0], value = kv[1];
    obj[decodeURIComponent(key)] = decodeURIComponent(value);
  }

  return obj;
}

function domainMatches(host, pattern) {
  if (!pattern) return false;
  if (pattern === '*') return true;
  host = host.toLowerCase();
  var parts = pattern.toLowerCase().split('*');
  if (host.indexOf(parts[0]) !== 0) return false;
  var p = parts[0].length;
  for (var i = 1; i < parts.length; i++) {
    var j = host.indexOf(parts[i], p);
    if (j === -1) return false;
    p = j + parts[i].length;
  }
  return parts[parts.length - 1] === '' || p === host.length;
}

function fetchPolicyFile(url, cache, callback) {
  if (url in cache) {
    return callback(cache[url]);
  }

  log('Fetching policy file at ' + url);
  var MAX_POLICY_SIZE = 8192;
  var xhr =  Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                               .createInstance(Ci.nsIXMLHttpRequest);
  xhr.open('GET', url, true);
  xhr.overrideMimeType('text/xml');
  xhr.onprogress = function (e) {
    if (e.loaded >= MAX_POLICY_SIZE) {
      xhr.abort();
      cache[url] = false;
      callback(null, 'Max policy size');
    }
  };
  xhr.onreadystatechange = function(event) {
    if (xhr.readyState === 4) {
      // TODO disable redirects
      var doc = xhr.responseXML;
      if (xhr.status !== 200 || !doc) {
        cache[url] = false;
        return callback(null, 'Invalid HTTP status: ' + xhr.statusText);
      }
      // parsing params
      var params = doc.documentElement.childNodes;
      var policy = { siteControl: null, allowAccessFrom: []};
      for (var i = 0; i < params.length; i++) {
        switch (params[i].localName) {
        case 'site-control':
          policy.siteControl = params[i].getAttribute('permitted-cross-domain-policies');
          break;
        case 'allow-access-from':
          var access = {
            domain: params[i].getAttribute('domain'),
            security: params[i].getAttribute('security') === 'true'
          };
          policy.allowAccessFrom.push(access);
          break;
        default:
          // TODO allow-http-request-headers-from and other
          break;
        }
      }
      callback(cache[url] = policy);
    }
  };
  xhr.send(null);
}

// All the priviledged actions.
function ChromeActions(url, window, document) {
  this.url = url;
  this.objectParams = null;
  this.movieParams = null;
  this.baseUrl = url;
  this.isOverlay = false;
  this.isPausedAtStart = false;
  this.window = window;
  this.document = document;
  this.externalComInitialized = false;
  this.allowScriptAccess = false;
  this.crossdomainRequestsCache = Object.create(null);
}

ChromeActions.prototype = {
  getBoolPref: function (data) {
    if (!/^shumway\./.test(data.pref)) {
      return null;
    }
    return getBoolPref(data.pref, data.def);
  },
  getCompilerSettings: function getCompilerSettings() {
    return JSON.stringify({
      appCompiler: getBoolPref('shumway.appCompiler', true),
      sysCompiler: getBoolPref('shumway.sysCompiler', false),
      verifier: getBoolPref('shumway.verifier', true)
    });
  },
  getPluginParams: function getPluginParams() {
    return JSON.stringify({
      url: this.url,
      baseUrl : this.baseUrl,
      movieParams: this.movieParams,
      objectParams: this.objectParams,
      isOverlay: this.isOverlay,
      isPausedAtStart: this.isPausedAtStart
     });
  },
  _canDownloadFile: function canDownloadFile(data, callback) {
    var url = data.url, checkPolicyFile = data.checkPolicyFile;

    // TODO flash cross-origin request
    if (url === this.url) {
      // allow downloading for the original file
      return callback({success: true});
    }

    // allows downloading from the same origin
    var urlPrefix = /^(https?):\/\/([A-Za-z0-9\-_\.\[\]]+)/i.exec(url);
    var basePrefix = /^(https?):\/\/([A-Za-z0-9\-_\.\[\]]+)/i.exec(this.url);
    if (basePrefix && urlPrefix && basePrefix[0] === urlPrefix[0]) {
      return callback({success: true});
    }

    // additionally using internal whitelist
    var whitelist = getStringPref('shumway.whitelist', '');
    if (whitelist && urlPrefix) {
      var whitelisted = whitelist.split(',').some(function (i) {
        return domainMatches(urlPrefix[2], i);
      });
      if (whitelisted) {
        return callback({success: true});
      }
    }

    if (!checkPolicyFile || !urlPrefix || !basePrefix) {
      return callback({success: false});
    }

    // we can request crossdomain.xml
    fetchPolicyFile(urlPrefix[0] + '/crossdomain.xml', this.crossdomainRequestsCache,
      function (policy, error) {

      if (!policy || policy.siteControl === 'none') {
        return callback({success: false});
      }
      // TODO assuming master-only, there are also 'by-content-type', 'all', etc.

      var allowed = policy.allowAccessFrom.some(function (i) {
        return domainMatches(basePrefix[2], i.domain) &&
          (!i.secure || basePrefix[1].toLowerCase() === 'https');
      });
      return callback({success: allowed});
    }.bind(this));
  },
  loadFile: function loadFile(data) {
    var url = data.url;
    var checkPolicyFile = data.checkPolicyFile;
    var sessionId = data.sessionId;
    var limit = data.limit || 0;
    var method = data.method || "GET";
    var mimeType = data.mimeType;
    var postData = data.postData || null;

    var win = this.window;
    var baseUrl = this.baseUrl;

    var performXHR = function () {
      var xhr = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]
                                  .createInstance(Ci.nsIXMLHttpRequest);
      xhr.open(method, url, true);
      xhr.responseType = "moz-chunked-arraybuffer";

      if (baseUrl) {
        // Setting the referer uri, some site doing checks if swf is embedded
        // on the original page.
        xhr.setRequestHeader("Referer", baseUrl);
      }

      // TODO apply range request headers if limit is specified

      var lastPosition = 0;
      xhr.onprogress = function (e) {
        var position = e.loaded;
        var data = new Uint8Array(xhr.response);
        win.postMessage({callback:"loadFile", sessionId: sessionId, topic: "progress",
                         array: data, loaded: e.loaded, total: e.total}, "*");
        lastPosition = position;
        if (limit && e.total >= limit) {
          xhr.abort();
        }
      };
      xhr.onreadystatechange = function(event) {
        if (xhr.readyState === 4) {
          if (xhr.status !== 200 && xhr.status !== 0) {
            win.postMessage({callback:"loadFile", sessionId: sessionId, topic: "error",
                             error: xhr.statusText}, "*");
          }
          win.postMessage({callback:"loadFile", sessionId: sessionId, topic: "close"}, "*");
        }
      };
      if (mimeType)
        xhr.setRequestHeader("Content-Type", mimeType);
      xhr.send(postData);
      win.postMessage({callback:"loadFile", sessionId: sessionId, topic: "open"}, "*");
    };

    this._canDownloadFile({url: url, checkPolicyFile: checkPolicyFile}, function (data) {
      if (data.success) {
        performXHR();
      } else {
        log("data access id prohibited to " + url + " from " + baseUrl);
        win.postMessage({callback:"loadFile", sessionId: sessionId, topic: "error",
          error: "only original swf file or file from the same origin loading supported"}, "*");
      }
    });
  },
  fallback: function() {
    var obj = this.window.frameElement;
    var doc = obj.ownerDocument;
    var e = doc.createEvent("CustomEvent");
    e.initCustomEvent("MozPlayPlugin", true, true, null);
    obj.dispatchEvent(e);
  },
  setClipboard: function (data) {
    if (typeof data !== 'string' ||
        data.length > MAX_CLIPBOARD_DATA_SIZE ||
        !this.document.hasFocus()) {
      return;
    }
    // TODO other security checks?

    let clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"]
                      .getService(Ci.nsIClipboardHelper);
    clipboard.copyString(data);
  },
  endActivation: function () {
    if (ActivationQueue.currentNonActive === this) {
      ActivationQueue.activateNext();
    }
  },
  externalCom: function (data) {
    if (!this.allowScriptAccess)
      return;

    // TODO check security ?
    var parentWindow = this.window.parent.wrappedJSObject;
    var embedTag = this.embedTag.wrappedJSObject;
    switch (data.action) {
    case 'init':
      if (this.externalComInitialized)
        return;

      this.externalComInitialized = true;
      var eventTarget = this.window.document;
      initExternalCom(parentWindow, embedTag, eventTarget);
      return;
    case 'getId':
      return embedTag.id;
    case 'eval':
      return parentWindow.__flash__eval(data.expression);
    case 'call':
      return parentWindow.__flash__call(data.request);
    case 'register':
      return embedTag.__flash__registerCallback(data.functionName);
    case 'unregister':
      return embedTag.__flash__unregisterCallback(data.functionName);
    }
  }
};

// Event listener to trigger chrome privedged code.
function RequestListener(actions) {
  this.actions = actions;
}
// Receive an event and synchronously or asynchronously responds.
RequestListener.prototype.receive = function(event) {
  var message = event.target;
  var action = event.detail.action;
  var data = event.detail.data;
  var sync = event.detail.sync;
  var actions = this.actions;
  if (!(action in actions)) {
    log('Unknown action: ' + action);
    return;
  }
  if (sync) {
    var response = actions[action].call(this.actions, data);
    var detail = event.detail;
    detail.__exposedProps__ = {response: 'r'};
    detail.response = response;
  } else {
    var response;
    if (event.detail.callback) {
      var cookie = event.detail.cookie;
      response = function sendResponse(response) {
        var doc = actions.document;
        try {
          var listener = doc.createEvent('CustomEvent');
          listener.initCustomEvent('shumway.response', true, false,
                                   {response: response,
                                    cookie: cookie,
                                    __exposedProps__: {response: 'r', cookie: 'r'}});

          return message.dispatchEvent(listener);
        } catch (e) {
          // doc is no longer accessible because the requestor is already
          // gone. unloaded content cannot receive the response anyway.
        }
      };
    }
    actions[action].call(this.actions, data, response);
  }
};

var ActivationQueue = {
  nonActive: [],
  initializing: -1,
  activationTimeout: null,
  get currentNonActive() {
    return this.nonActive[this.initializing];
  },
  enqueue: function ActivationQueue_enqueue(actions) {
    this.nonActive.push(actions);
    if (this.nonActive.length === 1) {
      this.activateNext();
    }
  },
  activateNext: function ActivationQueue_activateNext() {
    function weightInstance(actions) {
      // set of heuristics for find the most important instance to load
      var weight = 0;
      // using linear distance to the top-left of the view area
      if (actions.embedTag) {
        var window = actions.window;
        var clientRect = actions.embedTag.getBoundingClientRect();
        weight -= Math.abs(clientRect.left - window.scrollX) +
                  Math.abs(clientRect.top - window.scrollY);
      }
      var doc = actions.document;
      if (!doc.hidden) {
        weight += 100000; // might not be that important if hidden
      }
      if (actions.embedTag &&
          actions.embedTag.ownerDocument.hasFocus()) {
        weight += 10000; // parent document is focused
      }
      return weight;
    }

    if (this.activationTimeout) {
      this.activationTimeout.cancel();
      this.activationTimeout = null;
    }

    if (this.initializing >= 0) {
      this.nonActive.splice(this.initializing, 1);
    }
    var weights = [];
    for (var i = 0; i < this.nonActive.length; i++) {
      try {
        var weight = weightInstance(this.nonActive[i]);
        weights.push(weight);
      } catch (ex) {
        // unable to calc weight the instance, removing
        log('Shumway instance weight calculation failed: ' + ex);
        this.nonActive.splice(i, 1);
        i--;
      }
    }

    do {
      if (this.nonActive.length === 0) {
        this.initializing = -1;
        return;
      }

      var maxWeightIndex = 0;
      var maxWeight = weights[0];
      for (var i = 1; i < weights.length; i++) {
        if (maxWeight < weights[i]) {
          maxWeight = weights[i];
          maxWeightIndex = i;
        }
      }
      try {
        this.initializing = maxWeightIndex;
        this.nonActive[maxWeightIndex].activationCallback();
        break;
      } catch (ex) {
        // unable to initialize the instance, trying another one
        log('Shumway instance initialization failed: ' + ex);
        this.nonActive.splice(maxWeightIndex, 1);
        weights.splice(maxWeightIndex, 1);
      }
    } while (true);

    var ACTIVATION_TIMEOUT = 3000;
    this.activationTimeout = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.activationTimeout.initWithCallback(function () {
      log('Timeout during shumway instance initialization');
      this.activateNext();
    }.bind(this), ACTIVATION_TIMEOUT, Ci.nsITimer.TYPE_ONE_SHOT);
  }
};

function createSandbox(window, preview) {
  function initScripts() {
    var scriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
                         .getService(Ci.mozIJSSubScriptLoader);
    if (preview) {
      scriptLoader.loadSubScript('resource://shumway/web/preview.js', sandbox);
      sandbox.runSniffer();
    } else {
      scriptLoader.loadSubScript('resource://shumway/shumway.js', sandbox);
      scriptLoader.loadSubScript('resource://shumway/web/avm-sandbox.js',
                                 sandbox);
      sandbox.runViewer();
    }
  }

  let sandbox = new Cu.Sandbox(window, {
    sandboxName : 'Shumway Sandbox',
    sandboxPrototype: window,
    wantXrays : false,
    wantXHRConstructor : true,
    wantComponents : false});
  sandbox.SHUMWAY_ROOT = "resource://shumway/";

  if (sandbox.document.readyState === "interactive" ||
      sandbox.document.readyState === "complete") {
    initScripts();
  } else {
    sandbox.document.addEventListener('DOMContentLoaded', initScripts);
  }
  return sandbox;
}

function initExternalCom(wrappedWindow, wrappedObject, targetDocument) {
  if (!wrappedWindow.__flash__initialized) {
    wrappedWindow.__flash__initialized = true;
    wrappedWindow.__flash__toXML = function __flash__toXML(obj) {
      switch (typeof obj) {
      case 'boolean':
        return obj ? '<true/>' : '<false/>';
      case 'number':
        return '<number>' + obj + '</number>';
      case 'object':
        if (obj === null) {
          return '<null/>';
        }
        if ('hasOwnProperty' in obj && obj.hasOwnProperty('length')) {
          // array
          var xml = '<array>';
          for (var i = 0; i < obj.length; i++) {
            xml += '<property id="' + i + '">' + __flash__toXML(obj[i]) + '</property>';
          }
          return xml + '</array>';
        }
        var xml = '<object>';
        for (var i in obj) {
          xml += '<property id="' + i + '">' + __flash__toXML(obj[i]) + '</property>';
        }
        return xml + '</object>';
      case 'string':
        return '<string>' + obj.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</string>';
      case 'undefined':
        return '<undefined/>';
      }
    };
    var sandbox = new Cu.Sandbox(wrappedWindow, {sandboxPrototype: wrappedWindow});
    wrappedWindow.__flash__eval = function (evalInSandbox, sandbox, expr) {
      this.console.log('__flash__eval: ' + expr);
      return evalInSandbox(expr, sandbox);
    }.bind(wrappedWindow, Cu.evalInSandbox, sandbox);
    wrappedWindow.__flash__call = function (expr) {
      this.console.log('__flash__call (ignored): ' + expr);
    };
  }
  wrappedObject.__flash__registerCallback = function (functionName) {
    wrappedWindow.console.log('__flash__registerCallback: ' + functionName);
    this[functionName] = function () {
      var args = Array.prototype.slice.call(arguments, 0);
      wrappedWindow.console.log('__flash__callIn: ' + functionName);
      var e = targetDocument.createEvent('CustomEvent');
      e.initCustomEvent('shumway.remote', true, false, {
        functionName: functionName,
        args: args,
        __exposedProps__: {args: 'r', functionName: 'r', result: 'rw'}
      });
      targetDocument.dispatchEvent(e);
      return e.detail.result;
    };
  };
  wrappedObject.__flash__unregisterCallback = function (functionName) {
    wrappedWindow.console.log('__flash__unregisterCallback: ' + functionName);
    delete this[functionName];
  };
}

function FlashStreamConverterBase() {
}

FlashStreamConverterBase.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupports,
      Ci.nsIStreamConverter,
      Ci.nsIStreamListener,
      Ci.nsIRequestObserver
  ]),

  /*
   * This component works as such:
   * 1. asyncConvertData stores the listener
   * 2. onStartRequest creates a new channel, streams the viewer and cancels
   *    the request so Shumway can do the request
   * Since the request is cancelled onDataAvailable should not be called. The
   * onStopRequest does nothing. The convert function just returns the stream,
   * it's just the synchronous version of asyncConvertData.
   */

  // nsIStreamConverter::convert
  convert: function(aFromStream, aFromType, aToType, aCtxt) {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },

  isValidRequest: function() {
    return true;
  },

  createChromeActions: function(window, document, urlHint) {
    var url;
    var baseUrl;
    var pageUrl;
    var element = window.frameElement;
    var isOverlay = false;
    var objectParams = {};
    if (element) {
      var tagName = element.nodeName;
      while (tagName != 'EMBED' && tagName != 'OBJECT') {
        // plugin overlay skipping until the target plugin is found
        isOverlay = true;
        element = element.parentNode;
        if (!element)
          throw 'Plugin element is not found';
        tagName = element.nodeName;
      }

      pageUrl = element.ownerDocument.location.href; // proper page url?

      if (tagName == 'EMBED') {
        for (var i = 0; i < element.attributes.length; ++i) {
          var paramName = element.attributes[i].localName.toLowerCase();
          objectParams[paramName] = element.attributes[i].value;
        }
      } else {
        url = element.getAttribute('data');
        for (var i = 0; i < element.childNodes.length; ++i) {
          var paramElement = element.childNodes[i];
          if (paramElement.nodeType != 1 ||
              paramElement.nodeName != 'PARAM') {
            continue;
          }
          var paramName = paramElement.getAttribute('name').toLowerCase();
          objectParams[paramName] = paramElement.getAttribute('value');
        }
      }
    }

    url = url || objectParams.src || objectParams.movie;
    baseUrl = objectParams.base || pageUrl;

    var movieParams = {};
    if (objectParams.flashvars) {
      movieParams = parseQueryString(objectParams.flashvars);
    }
    var queryStringMatch = /\?([^#]+)/.exec(url);
    if (queryStringMatch) {
      var queryStringParams = parseQueryString(queryStringMatch[1]);
      for (var i in queryStringParams) {
        if (!(i in movieParams)) {
          movieParams[i] = queryStringParams[i];
        }
      }
    }

    url = !url ? urlHint : Services.io.newURI(url, null,
      baseUrl ? Services.io.newURI(baseUrl, null, null) : null).spec;

    var allowScriptAccess = false;
    switch (objectParams.allowscriptaccess || 'sameDomain') {
    case 'always':
      allowScriptAccess = true;
      break;
    case 'never':
      allowScriptAccess = false;
      break;
    default:
      if (!pageUrl)
        break;
      try {
        // checking if page is in same domain (? same protocol and port)
        allowScriptAccess =
          Services.io.newURI('/', null, Services.io.newURI(pageUrl, null, null)).spec ==
          Services.io.newURI('/', null, Services.io.newURI(url, null, null)).spec;
      } catch (ex) {}
      break;
    }

    var actions = new ChromeActions(url, window, document);
    actions.objectParams = objectParams;
    actions.movieParams = movieParams;
    actions.baseUrl = baseUrl || url;
    actions.isOverlay = isOverlay;
    actions.embedTag = element;
    actions.isPausedAtStart = /\bpaused=true$/.test(urlHint);
    actions.allowScriptAccess = allowScriptAccess;
    return actions;
  },

  // nsIStreamConverter::asyncConvertData
  asyncConvertData: function(aFromType, aToType, aListener, aCtxt) {
    if(!this.isValidRequest(aCtxt))
      throw Cr.NS_ERROR_NOT_IMPLEMENTED;

    // Store the listener passed to us
    this.listener = aListener;
  },

  // nsIStreamListener::onDataAvailable
  onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
    // Do nothing since all the data loading is handled by the viewer.
    log('SANITY CHECK: onDataAvailable SHOULD NOT BE CALLED!');
  },

  // nsIRequestObserver::onStartRequest
  onStartRequest: function(aRequest, aContext) {
    // Setup the request so we can use it below.
    aRequest.QueryInterface(Ci.nsIChannel);
    // Cancel the request so the viewer can handle it.
    aRequest.cancel(Cr.NS_BINDING_ABORTED);

    var originalURI = aRequest.URI;

    // checking if the plug-in shall be run in simple mode
    var isSimpleMode = originalURI.spec === EXPECTED_PLAYPREVIEW_URI_PREFIX &&
                       getBoolPref('shumway.simpleMode', false);

    // Create a new channel that loads the viewer as a resource.
    var channel = Services.io.newChannel(isSimpleMode ?
                    'resource://shumway/web/simple.html' :
                    'resource://shumway/web/viewer.html', null, null);

    var converter = this;
    var listener = this.listener;
    // Proxy all the request observer calls, when it gets to onStopRequest
    // we can get the dom window.
    var proxy = {
      onStartRequest: function() {
        listener.onStartRequest.apply(listener, arguments);
      },
      onDataAvailable: function() {
        listener.onDataAvailable.apply(listener, arguments);
      },
      onStopRequest: function() {
        var domWindow = getDOMWindow(channel);
        if (domWindow.document.documentURIObject.equals(channel.originalURI)) {
          // Double check the url is still the correct one.
          let actions = converter.createChromeActions(domWindow,
                                                      domWindow.document,
                                                      originalURI.spec);
          if (actions.objectParams['shumwaymode'] === 'off') {
            actions.fallback();
            return;
          }

          actions.activationCallback = function(domWindow, isSimpleMode) {
            delete this.activationCallback;
            createSandbox(domWindow, isSimpleMode);
          }.bind(actions, domWindow, isSimpleMode);
          ActivationQueue.enqueue(actions);

          let requestListener = new RequestListener(actions);
          domWindow.addEventListener('shumway.message', function(event) {
            requestListener.receive(event);
          }, false, true);
        }
        listener.onStopRequest.apply(listener, arguments);
      }
    };

    // XXX? Keep the URL the same so the browser sees it as the same.
    // channel.originalURI = aRequest.URI;
    channel.asyncOpen(proxy, aContext);
  },

  // nsIRequestObserver::onStopRequest
  onStopRequest: function(aRequest, aContext, aStatusCode) {
    // Do nothing.
  }
};

// properties required for XPCOM registration:
function copyProperties(obj, template) {
  for (var prop in template) {
    obj[prop] = template[prop];
  }
}

function FlashStreamConverter1() {}
FlashStreamConverter1.prototype = new FlashStreamConverterBase();
copyProperties(FlashStreamConverter1.prototype, {
  classID: Components.ID('{4c6030f7-e20a-264f-5b0e-ada3a9e97384}'),
  classDescription: 'Shumway Content Converter Component',
  contractID: '@mozilla.org/streamconv;1?from=application/x-shockwave-flash&to=*/*'
});

function FlashStreamConverter2() {}
FlashStreamConverter2.prototype = new FlashStreamConverterBase();
copyProperties(FlashStreamConverter2.prototype, {
  classID: Components.ID('{4c6030f7-e20a-264f-5f9b-ada3a9e97384}'),
  classDescription: 'Shumway PlayPreview Component',
  contractID: '@mozilla.org/streamconv;1?from=application/x-moz-playpreview&to=*/*'
});
FlashStreamConverter2.prototype.isValidRequest =
  (function(aCtxt) {
    try {
      var request = aCtxt;
      request.QueryInterface(Ci.nsIChannel);
      var spec = request.URI.spec;
      return spec.indexOf(EXPECTED_PLAYPREVIEW_URI_PREFIX) === 0;
    } catch (e) {
      return false;
    }
  });

var NSGetFactory1 = XPCOMUtils.generateNSGetFactory([FlashStreamConverter1]);
var NSGetFactory2 = XPCOMUtils.generateNSGetFactory([FlashStreamConverter2]);
