/*
 * This file is part of Privacy Badger <https://privacybadger.org/>
 * Copyright (C) 2014 Electronic Frontier Foundation
 *
 * Privacy Badger is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Privacy Badger is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Privacy Badger.  If not, see <http://www.gnu.org/licenses/>.
 */

/* globals badger:false */

import { getBaseDomain } from "../lib/basedomain.js";

import { log } from "./bootstrap.js";
import constants from "./constants.js";
import utils from "./utils.js";

function getManagedStorage(callback) {
  chrome.storage.managed.get(null, function (res) {
    if (chrome.runtime.lastError) {
      // ignore "Managed storage manifest not found" errors in Firefox
    }
    callback(res);
  });
}

function ingestManagedStorage(managedStore) {
  let settings = {};
  for (let key in badger.defaultSettings) {
    if (utils.hasOwn(managedStore, key)) {
      settings[key] = managedStore[key];
    }
  }
  badger.getSettings().merge(settings);
}

let pollForManagedStorage = (function () {
  const POLL_INTERVAL = 300,
    MAX_TRIES = 15; // ~4.5 second delay to see welcome page for most users

  return function (num_tries, callback) {
    getManagedStorage(function (managedStore) {
      if (utils.isObject(managedStore) && Object.keys(managedStore).length) {
        // success
        ingestManagedStorage(managedStore);
        callback();
        return;
      }

      num_tries++;
      if (num_tries <= MAX_TRIES) {
        // retry after a wait
        setTimeout(function () {
          pollForManagedStorage(num_tries, callback);
        }, POLL_INTERVAL);
      } else {
        // give up
        callback();
      }
    });
  };
}());

/**
 * See the following link for documentation of
 * Privacy Badger's data objects in extension storage:
 *
 * https://github.com/EFForg/privacybadger/blob/master/doc/DESIGN-AND-ROADMAP.md#data-structures
 */
function BadgerPen(callback) {
  let self = this;

  if (!callback) {
    callback = function () {};
  }

  // initialize from extension local storage
  chrome.storage.local.get(self.KEYS, function (store) {
    self.KEYS.forEach(key => {
      if (utils.hasOwn(store, key)) {
        self[key] = new BadgerStorage(key, store[key]);
      } else {
        let storageObj = new BadgerStorage(key, {});
        self[key] = storageObj;
        _syncStorage(storageObj);
      }
    });

    badger.initSettings();

    if (!chrome.storage.managed) {
      setTimeout(function () {
        badger.initWelcomePage();
      }, 0);
      callback(self);
      return;
    }

    // see if we have any enterprise/admin/group policy overrides
    getManagedStorage(function (managedStore) {
      // there are values in managed storage
      if (utils.isObject(managedStore) && Object.keys(managedStore).length) {
        ingestManagedStorage(managedStore);
        setTimeout(function () {
          badger.initWelcomePage();
        }, 0);
        callback(self);
        return;
      }

      // managed storage is empty

      if (badger.isFirstRun) {
        // poll for managed storage to work around Chromium bug
        pollForManagedStorage(0, function () {
          badger.initWelcomePage();
        });
      } else {
        setTimeout(function () {
          badger.initWelcomePage();
        }, 0);
      }

      callback(self);
    });
  });
}

BadgerPen.prototype = {
  KEYS: [
    "snitch_map",
    "action_map",
    "cookieblock_list",
    "dnt_hashes",
    "settings_map",

    // misc. utility settings, not for export
    "private_storage",

    // logs what kind of tracking was observed:
    // {
    //   <tracker_base>: {
    //     <site_base>: [
    //       <tracking_type>, // "canvas" or "pixelcookieshare"
    //       ...
    //     ],
    //     ...
    //   },
    //   ...
    // }
    "tracking_map",
  ],

  getStore: function (key) {
    if (utils.hasOwn(this, key)) {
      return this[key];
    }
    console.error("Can't initialize cache from getStore. You are using this API improperly");
  },

  /**
   * Reset the snitch map and action map, forgetting all data the badger has
   * learned from browsing.
   */
  clearTrackerData: function () {
    let self = this;
    ['action_map', 'snitch_map', 'tracking_map'].forEach(key => {
      self.getStore(key).updateObject({});
    });
  },

  /**
   * Get the current presumed action for a specific fully qualified domain name (FQDN),
   * ignoring any rules for subdomains below or above it
   *
   * @param {(Object|String)} domain domain object from action_map
   * @param {Boolean} [ignoreDNT] whether to ignore DNT status
   * @returns {String} the presumed action for this FQDN
   */
  getAction: function (domain, ignoreDNT) {
    if (!badger.isCheckingDNTPolicyEnabled()) {
      ignoreDNT = true;
    }

    if (utils.isString(domain)) {
      domain = this.getStore('action_map').getItem(domain) || {};
    }
    if (domain.userAction) { return domain.userAction; }
    if (domain.dnt && !ignoreDNT) { return constants.DNT; }
    if (domain.heuristicAction) { return domain.heuristicAction; }
    return constants.NO_TRACKING;
  },

  touchDNTRecheckTime: function (domain, time) {
    this._setupDomainAction(domain, time, "nextUpdateTime");
  },

  getNextUpdateForDomain: function (domain) {
    let action_map = this.getStore('action_map');
    if (action_map.hasItem(domain)) {
      return action_map.getItem(domain).nextUpdateTime;
    } else {
      return 0;
    }
  },

  /**
   * Updates the yellowlist to the provided array of domains.
   *
   * For each added domain, sets it to be cookieblocked
   * if its parent domain is set to be blocked.
   *
   * @param {Array} newDomains domains to use for the new yellowlist
   */
  updateYellowlist: function (newDomains) {
    let self = this,
      actionMap = self.getStore('action_map'),
      ylistStorage = self.getStore('cookieblock_list'),
      oldDomains = ylistStorage.keys();

    let addedDomains = utils.difference(newDomains, oldDomains),
      removedDomains = utils.difference(oldDomains, newDomains);

    log('adding to cookie blocklist:', addedDomains);
    addedDomains.forEach(function (domain) {
      ylistStorage.setItem(domain, true);

      const base = getBaseDomain(domain);
      if (actionMap.hasItem(base)) {
        const action = actionMap.getItem(base).heuristicAction;
        // if the domain's base domain is marked for blocking
        if (action == constants.BLOCK || action == constants.COOKIEBLOCK) {
          // cookieblock the domain
          self.setupHeuristicAction(domain, constants.COOKIEBLOCK);
        }
      }
    });

    log('removing from cookie blocklist:', removedDomains);
    removedDomains.forEach(function (domain) {
      ylistStorage.deleteItem(domain);

      const base = getBaseDomain(domain);
      // "subdomains" include the domain itself
      for (const subdomain of actionMap.keys()) {
        if (getBaseDomain(subdomain) == base) {
          if (self.getAction(subdomain) != constants.NO_TRACKING) {
            badger.heuristicBlocking.blocklistOrigin(base, subdomain);
          }
        }
      }
    });
  },

  /**
   * Update DNT policy hashes
   */
  updateDntHashes: function (hashes) {
    let dnt_hashes = this.getStore('dnt_hashes');
    dnt_hashes.updateObject(utils.invert(hashes));
  },

  /**
   * Looks up whether an FQDN would get cookieblocked,
   * ignoring user overrides and the FQDN's current status.
   *
   * @param {String} fqdn the FQDN we want to look up
   *
   * @return {Boolean}
   */
  wouldGetCookieblocked: function (fqdn) {
    // cookieblock if a "parent" domain of the fqdn is on the yellowlist
    let set = false,
      ylistStorage = this.getStore('cookieblock_list'),
      // ignore base domains when exploding to work around PSL TLDs:
      // still want to cookieblock somedomain.googleapis.com with only
      // googleapis.com (and not somedomain.googleapis.com itself) on the ylist
      subdomains = utils.explodeSubdomains(fqdn, true);

    for (let i = 0; i < subdomains.length; i++) {
      if (ylistStorage.hasItem(subdomains[i])) {
        set = true;
        break;
      }
    }

    return set;
  },

  /**
   * Find the best action to take for an FQDN, assuming it is third party and
   * Privacy Badger is enabled. Traverse the action list for the FQDN and each
   * of its subdomains and then takes the most appropriate action
   *
   * @param {String} fqdn the FQDN we want to determine the action for
   * @returns {String} the best action for the FQDN
   */
  getBestAction: function (fqdn) {
    let self = this,
      action_map = self.getStore('action_map'),
      best_action = constants.NO_TRACKING,
      subdomains = utils.explodeSubdomains(fqdn);

    function getScore(action) {
      switch (action) {
      case constants.NO_TRACKING:
        return 0;
      case constants.ALLOW:
        return 1;
      case constants.BLOCK:
        return 2;
      case constants.COOKIEBLOCK:
        return 3;
      case constants.DNT:
        return 4;
      case constants.USER_ALLOW:
      case constants.USER_BLOCK:
      case constants.USER_COOKIEBLOCK:
        return 5;
      }
    }

    // Loop through each subdomain we have a rule for
    // from least (base domain) to most (FQDN) specific
    // and keep the one which has the best score.
    for (let i = subdomains.length - 1; i >= 0; i--) {
      let domain = subdomains[i];
      if (action_map.hasItem(domain)) {
        let action = self.getAction(
          action_map.getItem(domain),
          // ignore DNT unless it's directly on the FQDN being checked
          domain != fqdn
        );
        if (getScore(action) >= getScore(best_action)) {
          best_action = action;
        }
      }
    }

    return best_action;
  },

  /**
   * Find every domain in the action_map where the presumed action would be {selector}
   *
   * @param {String} selector the action to select by
   * @return {Array} an array of FQDN strings
   */
  getAllDomainsByPresumedAction: function (selector) {
    let self = this,
      action_map = self.getStore('action_map'),
      relevantDomains = [];

    for (let domain in action_map.getItemClones()) {
      if (selector == self.getAction(domain)) {
        relevantDomains.push(domain);
      }
    }

    return relevantDomains;
  },

  /**
   * Get all tracking domains from action_map.
   *
   * @return {Object} An object with domains as keys and actions as values.
   */
  getTrackingDomains: function () {
    let action_map = this.getStore('action_map');
    let origins = {};

    for (let domain in action_map.getItemClones()) {
      let action = badger.storage.getBestAction(domain);
      if (action != constants.NO_TRACKING) {
        origins[domain] = action;
      }
    }

    return origins;
  },

  /**
   * Set up an action for a domain of the given action type in action_map
   *
   * @param {String} domain the domain to set the action for
   * @param {String} action the action to take e.g. BLOCK || COOKIEBLOCK || DNT
   * @param {String} actionType the type of action we are setting, one of "userAction", "heuristicAction", "dnt"
   * @private
   */
  _setupDomainAction: function (domain, action, actionType) {
    let msg = "action_map['%s'].%s = %s",
      action_map = this.getStore("action_map"),
      actionObj = {};

    if (action_map.hasItem(domain)) {
      actionObj = action_map.getItem(domain);
      msg = "Updating " + msg;
    } else {
      actionObj = _newActionMapObject();
      msg = "Initializing " + msg;
    }
    actionObj[actionType] = action;

    if (window.DEBUG) { // to avoid needless JSON.stringify calls
      log(msg, domain, actionType, JSON.stringify(action));
    }
    action_map.setItem(domain, actionObj);
  },

  /**
   * Add a heuristic action for a domain
   *
   * @param {String} domain Domain to add
   * @param {String} action The heuristic action to take
   */
  setupHeuristicAction: function(domain, action) {
    this._setupDomainAction(domain, action, "heuristicAction");
  },

  /**
   * Set up a domain for DNT
   *
   * @param {String} domain Domain to add
   */
  setupDNT: function (domain) {
    this._setupDomainAction(domain, true, "dnt");
  },

  /**
   * Remove DNT setting from a domain*
   * @param {String} domain FQDN string
   */
  revertDNT: function (domain) {
    this._setupDomainAction(domain, false, "dnt");
  },

  /**
   * Add a heuristic action for a domain
   *
   * @param {String} domain Domain to add
   * @param {String} action The heuristic action to take
   */
  setupUserAction: function(domain, action) {
    this._setupDomainAction(domain, action, "userAction");
  },

  /**
   * Remove user set action from a domain
   * @param {String} domain FQDN string
   */
  revertUserAction: function (domain) {
    this._setupDomainAction(domain, "", "userAction");

    // if Privacy Badger never recorded tracking for this domain,
    // remove the domain's entry from Privacy Badger's database
    const actionMap = this.getStore("action_map");
    if (actionMap.getItem(domain).heuristicAction == "") {
      log("Removing %s from action_map", domain);
      actionMap.deleteItem(domain);
    }
  },

  /**
   * Removes a base domain and its subdomains from snitch and action maps.
   * Preserves action map entries with user overrides.
   *
   * @param {String} base_domain
   */
  forget: function (base_domain) {
    let self = this,
      dot_base = '.' + base_domain,
      actionMap = self.getStore('action_map'),
      actions = actionMap.getItemClones(),
      snitchMap = self.getStore('snitch_map'),
      trackingMap = self.getStore('tracking_map');

    if (snitchMap.getItem(base_domain)) {
      log("Removing %s from snitch_map", base_domain);
      snitchMap.deleteItem(base_domain);
    }

    if (trackingMap.getItem(base_domain)) {
      log("Removing %s from tracking_map", base_domain);
      trackingMap.deleteItem(base_domain);
    }

    for (let domain in actions) {
      if (domain == base_domain || domain.endsWith(dot_base)) {
        if (actions[domain].userAction == "") {
          log("Removing %s from action_map", domain);
          actionMap.deleteItem(domain);
        }
      }
    }
  },

  /**
   * Forces a write of a Badger storage object's contents to extension storage.
   */
  forceSync: function (store_name, callback) {
    let self = this;
    if (!self.KEYS.includes(store_name)) {
      setTimeout(function () {
        callback("Error: Unknown Badger storage name");
      }, 0);
      return;
    }
    _syncStorage(self.getStore(store_name), true, callback);
  },

  /**
   * Simplifies updating tracking_map.
   */
  recordTrackingDetails: function (tracker_base, site_base, tracking_type) {
    let self = this,
      trackingDataStore = self.getStore('tracking_map'),
      entry = trackingDataStore.getItem(tracker_base) || {};
    if (!utils.hasOwn(entry, site_base)) {
      entry[site_base] = [];
    }
    if (!entry[site_base].includes(tracking_type)) {
      entry[site_base].push(tracking_type);
    }
    trackingDataStore.setItem(tracker_base, entry);
  },
};

/**
 * @private
 */
function _newActionMapObject() {
  return {
    userAction: "",
    dnt: false,
    heuristicAction: "",
    nextUpdateTime: 0
  };
}

/**
 * Privacy Badger Storage Object.
 * Should be used for all storage needs.
 */

/**
 * BadgerStorage constructor
 * *DO NOT USE DIRECTLY* Instead call `getStore(name)`
 * @param {String} name - the name of the storage object
 * @param {Object} seed - the base object which we are instantiating from
 */
function BadgerStorage(name, seed) {
  this.name = name;
  this._store = seed;
  this._subscribers = {}; // basic pub-sub
}

BadgerStorage.prototype = {
  /**
   * Check if this storage object has an item
   *
   * @param {String} key - the key for the item
   * @return {Boolean}
   */
  hasItem: function (key) {
    let self = this;
    return utils.hasOwn(self._store, key);
  },

  /**
   * Get an item
   *
   * @param {String} key - the key for the item
   * @return {?*} the value for that key or null
   */
  getItem: function (key) {
    let self = this;
    if (self.hasItem(key)) {
      // return a clone of the value in storage
      let str = JSON.stringify(self._store[key]);
      return (str === undefined ? str : JSON.parse(str));
    } else {
      return null;
    }
  },

  /**
   * Get all items in the object as a copy
   *
   * @return {*} the items in badgerObject
   */
  getItemClones: function () {
    let self = this;
    return JSON.parse(JSON.stringify(self._store));
  },

  /**
   * Set an item
   *
   * @param {String} key - the key for the item
   * @param {*} value - the new value
   */
  setItem: function (key, value) {
    let self = this;
    self.notify("set:" + key, key, value);
    self._store[key] = value;
    setTimeout(function () {
      _syncStorage(self);
    }, 0);
  },

  /**
   * Delete an item
   *
   * @param {String} key - the key for the item
   */
  deleteItem: function (key) {
    let self = this;
    delete self._store[key];
    setTimeout(function () {
      _syncStorage(self);
    }, 0);
  },

  /**
   * Update the entire object that this instance is storing
   */
  updateObject: function (object) {
    let self = this;
    self._store = object;
    setTimeout(function () {
      _syncStorage(self);
    }, 0);
  },

  /**
   * @returns {Array} this storage object's store keys
   */
  keys: function () {
    return Object.keys(this._store);
  },

  /**
   * When a user imports data via the Import function, we want to overwrite
   * any existing settings, while simultaneously merging in any new information
   * (i.e. the list of disabled site domains). Thus, we need different logic
   * for each of the storage objects based on their internal structure.
   *
   * This is also used to load pre-trained data, and to ingest managed storage.
   *
   * @param {Object} mapData The storage object to merge into existing storage
   */
  merge: function (mapData) {
    const self = this;

    if (self.name == "settings_map") {
      for (let prop in mapData) {
        // combine array settings via intersection/union
        if (prop == "disabledSites" || prop == "widgetReplacementExceptions") {
          self.setItem(prop, utils.concatUniq(self.getItem(prop), mapData[prop]));

        // string/array map
        } else if (prop == "widgetSiteAllowlist") {
          let existingEntry = self.getItem(prop);

          // for every site host in the import
          for (let site in mapData[prop]) {
            // combine exception arrays
            existingEntry[site] = utils.concatUniq(
              existingEntry[site], mapData[prop][site]);
          }

          self.setItem(prop, existingEntry);

        // default: overwrite existing setting with setting from import
        } else {
          if (utils.hasOwn(badger.defaultSettings, prop)) {
            self.setItem(prop, mapData[prop]);
          } else {
            console.error("Unknown Badger setting:", prop);
          }
        }
      }

    } else if (self.name == "action_map") {
      for (let domain in mapData) {
        let newEntry = mapData[domain],
          existingEntry = self.getItem(domain);

        // copy over any user settings from the merged-in data
        if (newEntry.userAction) {
          if (existingEntry) {
            existingEntry.userAction = newEntry.userAction;
            self.setItem(domain, existingEntry);
          } else {
            self.setItem(domain, Object.assign(_newActionMapObject(), newEntry));
          }
        }

        // handle Do Not Track
        if (existingEntry) {
          // merge DNT settings if the imported data has a more recent update
          if (newEntry.nextUpdateTime > existingEntry.nextUpdateTime) {
            existingEntry.nextUpdateTime = newEntry.nextUpdateTime;
            existingEntry.dnt = newEntry.dnt;
            self.setItem(domain, existingEntry);
          }
        } else {
          // import action map entries for new DNT-compliant domains
          if (newEntry.dnt) {
            self.setItem(domain, Object.assign(_newActionMapObject(), newEntry));
          }
        }
      }

    } else if (self.name == "snitch_map") {
      for (let tracker_base in mapData) {
        let siteBases = mapData[tracker_base];
        for (let site_base of siteBases) {
          badger.heuristicBlocking.updateTrackerPrevalence(
            tracker_base, tracker_base, site_base);
        }
      }

    } else if (self.name == "tracking_map") {
      let snitchMap = badger.storage.getStore('snitch_map');
      for (let tracker_base in mapData) {
        // merge only if we have a corresponding snitch_map entry
        let snitchItem = snitchMap.getItem(tracker_base);
        if (!snitchItem) {
          continue;
        }
        for (let site_base in mapData[tracker_base]) {
          if (!snitchItem.includes(site_base)) {
            continue;
          }
          for (let tracking_type of mapData[tracker_base][site_base]) {
            badger.storage.recordTrackingDetails(
              tracker_base, site_base, tracking_type);
          }
        }
      }
    }
  },

  /**
   * @param {String} name The event to notify subscribers for
   * @param {String} key The storage key being created/updated
   * @param {*} val The new value being assigned to the key
   */
  notify: function (name, key, val) {
    let self = this;

    function _notify(ename) {
      if (self._subscribers[ename]) {
        for (let fn of self._subscribers[ename]) {
          let str = JSON.stringify(val),
            val_clone = (str === undefined ? str : JSON.parse(str));
          fn.call(self, val_clone, key);
        }
      }
    }

    // exact match subscribers
    _notify(name);

    // wildcard subscribers
    _notify(name.slice(0, name.indexOf(":") + 1) + "*");
  },

  /**
   * @param {String} name The event to subscribe to
   * @param {Function} callback
   */
  subscribe: function (name, callback) {
    let self = this;
    if (!self._subscribers[name]) {
      self._subscribers[name] = [];
    }
    self._subscribers[name].push(callback);
  },
};

let _syncStorage = (function () {
  let debouncedFuncs = {};

  function _sync(badgerStore, callback) {
    if (!callback) {
      callback = function () {};
    }
    let obj = {};
    obj[badgerStore.name] = badgerStore._store;
    chrome.storage.local.set(obj, function () {
      if (!chrome.runtime.lastError) {
        callback(null);
        return;
      }
      let err = chrome.runtime.lastError.message;
      if (!err.startsWith("IO error:") && !err.startsWith("Corruption:") &&
        !err.startsWith("InvalidStateError:") && !err.startsWith("AbortError:") &&
        !err.startsWith("QuotaExceededError:")) {
        badger.criticalError = err;
      }
      console.error("Error writing to chrome.storage.local:", err);
      callback(err);
    });
  }

  /**
   * Writes contents of Badger storage objects to extension storage.
   *
   * The writing is debounced by default.
   *
   * @param {BadgerStorage} badgerStore
   * @param {Boolean} [force] perform sync immediately if truthy
   * @param {Function} [callback] ONLY USED WHEN FORCING IMMEDIATE SYNC
   */
  return function (badgerStore, force, callback) {
    // bypass debouncing
    if (force) {
      _sync(badgerStore, callback);
      return;
    }
    // create debounced versions of _sync(), one per BadgerPen.prototype.KEYS
    if (!utils.hasOwn(debouncedFuncs, badgerStore.name)) {
      // call sync at most once every two seconds
      debouncedFuncs[badgerStore.name] = utils.debounce(function () {
        _sync(badgerStore);
      }, 2000);
    }
    debouncedFuncs[badgerStore.name]();
  };
}());

export default BadgerPen;
