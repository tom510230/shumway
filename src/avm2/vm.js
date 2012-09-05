var AVM2 = (function () {

  function AVM2(sysMode, appMode) {
    // TODO: this will change when we implement security domains.
    this.systemDomain = new Domain(this, null, sysMode, true);
    this.applicationDomain = new Domain(this, this.systemDomain, appMode, false);

    // Triggered whenever an AS3 class instance is constructed.
    this.onConstruct = undefined;
  }

  AVM2.currentVM = function () {
    return Runtime.stack.top().domain.system.vm;
  };

  AVM2.prototype = {
    notifyConstruct: function notifyConstruct (instance, args) {
      return this.onConstruct ? this.onConstruct(instance, args) : undefined;
    }
  };

  return AVM2;

})();
