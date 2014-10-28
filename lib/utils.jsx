/** @jsx React.DOM */
var React         = require('react');
var _             = require('lodash');
var auth          = require('./auth');
var Promise       = require('promise');
var debug         = require('debug')('lib:utils');
var assert        = require('assert');
var awesome       = require('react-font-awesome');
var taskcluster   = require('taskcluster-client');
var debug         = require('debug')('lib:utils');

/**
 * Logic for loading state using taskcluster-client
 *
 * Implementors can provide:
 *   - `load(props)` returns a map from property to state,
 *     example: `{property: promise}`.
 *
 * Implementors can also call `loadState({property: promise})` with a mapping
 * from property to promise.
 *
 * When a promise is successful state will be set as follows:
 * {
 *   propertyLoaded:   true,
 *   propertyError:    undefined,
 *   property:         result from promise
 * }
 *
 * If a promise is resolved unsuccessfully state will be set as follows:
 * {
 *   propertyLoaded:   true,
 *   propertyError:    Error Object,
 *   property:         undefined
 * }
 *
 * While a promise is waiting to be resolved state will be set as follows:
 * {
 *   propertyLoaded:   false,
 *   propertyError:    undefined,
 *   property:         undefined
 * }
 *
 * When rendering `!propertyLoaded` will be true if it either haven't started
 * loading or is loading.
 */
var createTaskClusterMixin = function(options) {
  // Set default options
  options = _.defaults({}, options, {
    clients:        {},
    reloadOnProps:  false   // List of properties to reload on, or `true`
  });
  return {
    /** Setup object and start listening for events */
    componentDidMount: function() {
      // Create clients with current credentials
      this._createClients(auth.loadCredentials());

      // Listen for changes to credentials
      window.addEventListener(
        'credentials-changed',
        this.handleCredentialsChanged,
        false
      );

      // Reload state (initial load)
      this.reload();
    },

    /** Check if the new properties causes us to reload */
    componentWillReceiveProps: function(nextProps) {
      // reload if we reload on any property change
      var shallReload = (options.reloadOnProps === true);

      // If reloadOnProps is an array, we'll check if any of the properties
      // defined in the list have changed
      if (!shallReload && options.reloadOnProps instanceof Array) {
        shallReload = _.some(options.reloadOnProps, function(property) {
          return this.props[property] !== nextProps[property];
        }, this);
      }

      // Reload state if we have to
      if (shallReload) {
        this.reload(nextProps);
      }
    },

    /** handle changes to credentials */
    handleCredentialsChanged: function(e) {
      // Update clients with new credentials
      this._createClients(e.detail);

      // Reload state now that we have new credentials
      this.reload();
    },

    /** Stop listening for events */
    componentWillUnmount: function() {
      // Remove credentials-changed event handler
      window.removeEventListener(
        'credentials-changed',
        this.handleCredentialsChanged,
        false
      );
    },

    /** Load state from a map from property to promise */
    loadState: function(promisedState) {
      assert(promisedState instanceof Object, "Expected an object");

      // map from promised state property to load iteration count, so that old
      // loads that are resolved after newer requests aren't overwriting newer
      // state information
      if (this.__promisedStateIterationMap === undefined) {
        this.__promisedStateIterationMap = {};
      }

      // Construct and set initial state and construct current
      // promisedStateIterationMap
      var promisedStateIterationMap = {};
      var state = {};
      _.forIn(promisedState, function(promise, key) {
        // Set loading state
        state[key + 'Loaded'] = false;
        state[key + 'Error']  = undefined;
        state[key]            = undefined;
        // Ensure that there is already an iteration
        if (this.__promisedStateIterationMap[key] === undefined) {
          this.__promisedStateIterationMap[key] = 0;
        }
        // Create a new iteration
        this.__promisedStateIterationMap[key] += 1;
        // Remember the current iteration
        promisedStateIterationMap[key] = this.__promisedStateIterationMap[key];
      }, this);
      this.setState(state);

      // Construct a method that'll set state loaded and ignore old state if
      // a new promise for the property has arrived since
      var setLoaded = function(key, result, err) {
        // Ignore state, if loadState have been called again with this property
        var currentIteration = this.__promisedStateIterationMap[key];
        if (promisedStateIterationMap[key] === currentIteration) {
          var state = {};
          state[key + 'Loaded'] = true;
          state[key + 'Error']  = err;
          state[key]            = result;
          this.setState(state);
        }
      }.bind(this);

      // Update state as promises are resolved
      var promises = _.map(promisedState, function(promise, key) {
        return Promise.resolve(promise).then(function(result) {
          // Set result state
          setLoaded(key, result, undefined);
        }, function(err) {
          debug("Error loading '%s', err: %s, as JSON: %j",
                key, err, err, err.stack);
          // Set error state
          setLoaded(key, undefined, err || new Error("Unknown Error"));
        });
      });

      // Return promise all promises are resolved
      return Promise.all(promises).then(function() {
        return undefined;
      });
    },

    /** Reload state given properties to reload with */
    reload: function(props) {
      // If there is no `load` function then we're done
      if (!(this.load instanceof Function)) {
        return Promise.resolve(undefined);
      }

      // If no properties are given we'll use current properties
      if (props === undefined) {
        props = this.props;
      }

      // Load state from promised state given by this.load()
      return this.loadState(this.load(props) || {});
    },

    /**
     * Render a spinner or error message if `property` isn't loaded
     * this assume that `property` is loaded through `load()`. Hence, state
     * should have properties:
     * {<property>Loaded, <property>Error, <property>}
     *
     * Returns undefined if the property is loaded.
     */
    renderWaitFor: function(property) {
      if (this.state[property + 'Loaded']) {
        if (this.state[property + 'Error']) {
          return this.renderError(this.state[property + 'Error']);
        }
      } else {
        return this.renderSpinner();
      }
      return undefined;
    },

    /** Render a spinner */
    renderSpinner: function() {
      return (
        <div style={{textAlign: 'center', margin: 20}}>
          <awesome.Icon type="spinner" size="2x" spin/>
        </div>
      );
    },

    /**
     * Error object, assumed to have message and possible properties from
     * taskcluster-client
     */
    renderError: function(err) {
      return <b>Error: {err.message}</b>;
    },

    /** Initialize client objects requested in options */
    _createClients: function(credentials) {
      _.forIn(options.clients, function(Client, key) {
        this[key] = new Client({
          // TODO: Fix this when deploying
          baseUrl:            'http://localhost:60550/v1',
          credentials:        credentials
        });
      }, this);
    },
  };
};

// Export createTaskClusterMixin
exports.createTaskClusterMixin = createTaskClusterMixin;

/**
 * Logic for listening to Pulse exchanges using WebListener
 *
 * This mixin offers method:
 *  - `startListening(bindings)`
 *  - `stopListening()`
 *
 * You can call `startListening(bindings)` repeatedly to listen to additional
 * bindings.
 *
 * This mixin adds the state property `listening` to state as follows:
 *
 * {
 *    listening:    true || false || null // null when connecting
 * }
 */
var createWebListenerMixin = function(options) {
  // Set default options
  options = _.defaults({}, options, {
    bindings:     [] // initial bindings
  });
  return {
    /** Start listening if bindings are configured */
    componentDidMount: function() {
      this.__listener = null;

      if (options.bindings.length > 0) {
        this.startListening(options.bindings.length);
      }
    },

    /** Stop listening */
    componentWillUnmount: function() {
      this.stopListening();
    },

    /** Start listening */
    startListening: function(bindings) {
      // Get bindings if none are provided
      if (!bindings || bindings.length === 0) {
        return Promise.resolve(undefined);
      }

      // If not listening start listening
      if (!this.__listener) {
        this.__listener = new taskcluster.WebListener();
        this.__listener.on('message', this.handleMessage);
        this.__listener.on('error', function(err) {
          debug("Error while listening: %s, %j", err, err);
          if (!err) {
            err = new Error("Unknown error");
          }
          this.setState({listeningError: err});
          this.stopListening();
        }.bind(this));

        // Bind to bindings
        var bound = bindings.map(function(binding) {
          return this.__listener.bind(binding);
        }, this);

        this.setState({
          listening:        null,
          listeningError:   undefined
        });
        return Promise.all(bound.concat([
          this.__listener.resume()
        ])).then(function() {
          debug("Listening for messages...");
          this.setState({
            listening:        true,
            listeningError:   undefined
          });
        }.bind(this), function(err) {
          debug("Error while listening: %s, %j", err, err);
          if (!err) {
            err = new Error("Unknown error");
          }
          this.setState({listeningError: err});
          return this.stopListening();
        }.bind(this));
      }

      // Bind to all new bindings
      this.setState({
        listening:        null,
        listeningError:   undefined
      });
      return Promise.all(bindings.map(function(binding) {
        return this.__listener.bind(binding);
      }, this)).then(function() {
        this.setState({
          listening:        true,
          listeningError:   undefined
        });
      }.bind(this), function(err) {
        debug("Error while listening: %s, %j", err, err);
        if (!err) {
          err = new Error("Unknown error");
        }
        this.setState({listeningError: err});
        return this.stopListening();
      }.bind(this));
    },

    /** Stop listening, if already listening */
    stopListening: function() {
      this.setState({listening: false});
      if (this.__listener) {
        var closed = this.__listener.close();
        this.__listener = null;
        return closed;
      }
      return Promise.resolve(undefined);
    }
  };
};

// Export createWebListenerMixin
exports.createWebListenerMixin = createWebListenerMixin;


/** Escape a string for use in a regular expression */
var escapeForRegularExpression = function(string) {
  return string.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
};


/** Apply a hexa decimal */
var escapeChar = function(character, string) {
  assert(character.length === 1, "character must have length 1");
  var regExp = new RegExp(escapeForRegularExpression(character), 'g');
  return string.replace(regExp, function(c) {
    return '%' + c.charCodeAt(0).toString(16);
  });
};

// Export escapeChar
exports.escapeChar = escapeChar;

/** Unescape a specific character, reversing escapeChar */
var unescapeChar = function(character, string) {
  assert(character.length === 1, "character must have length 1");
  var needle = '%' + character.charCodeAt(0).toString(16);
  var regExp = new RegExp(escapeForRegularExpression(needle), 'g');
  return string.replace(regExp, character);
};

// Export unescapeChar
exports.unescapeChar = unescapeChar;

/** Encode string for use in window.location.hash */
var encodeFragment = function(string) {
  return string.replace(/[^a-zA-Z0-9!$&'()*+,;=:@\-._~?\/]/g, function(c) {
    return '%' + c.charCodeAt(0).toString(16);
  });
};

// Export encodeFragment
exports.encodeFragment = encodeFragment;

var createLocationHashMixin =  function(options) {
  assert((options.save instanceof Function &&
          options.load instanceof Function) ||
         options.key, "save/load or key must given");
  // Provide default options
  options = _.defaults({}, options, {
    defaultValue:     '',
    save: function() {
      return this.state[options.key] || options.defaultValue;
    },
    load: function(data) {
      var state = {};
      state[options.key] = data || options.defaultValue;
      if (this.state[options.key] !== state[options.key]) {
        this.setState(state);
      }
    }
  });
  return {
    componentWillMount: function() {
      this.__previousHashFragment = undefined;
      this.handleHashChange();
    },

    componentDidMount: function() {
      window.addEventListener('hashchange', this.handleHashChange, false);
    },

    componentWillUnmount: function() {
      window.removeEventListener('hashchange', this.handleHashChange, false);
    },

    componentDidUpdate: function() {
      var hash          = decodeURIComponent(window.location.hash.substr(1));
      var fragments     = hash.split('/');
      var oldFragment   = fragments[this.props.hashIndex] || '';
      var newFragment   = escapeChar('/', options.save.call(this) || '');
      if (oldFragment !== newFragment) {
        fragments[this.props.hashIndex] = newFragment;
        window.location.hash = '#' + encodeFragment(fragments.join('/'));
      }
    },

    handleHashChange: function() {
      var hash      = decodeURIComponent(window.location.hash.substr(1));
      var fragments = hash.split('/');
      var fragment  = fragments[this.props.hashIndex] || '';
      if (this.__previousHashFragment !== fragment) {
        this.__previousHashFragment = fragment;
        options.load.call(this, unescapeChar('/', fragment));
      }
    }
  };
};

// Export createLocationHashMixin
exports.createLocationHashMixin = createLocationHashMixin;