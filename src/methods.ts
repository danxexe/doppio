"use strict";
import util = require('./util');
import opcodes = require('./opcodes');
import attributes = require('./attributes');
import runtime = require('./runtime');
import logging = require('./logging');
import JVM = require('./jvm');
import exceptions = require('./exceptions');
import java_object = require('./java_object');
import ConstantPool = require('./ConstantPool');
import ClassData = require('./ClassData');
import threading = require('./threading');
import gLong = require('./gLong');


var ReturnException = exceptions.ReturnException;
var vtrace = logging.vtrace, trace = logging.trace, debug_vars = logging.debug_vars;
var JavaArray = java_object.JavaArray;
var JavaObject = java_object.JavaObject;
declare var RELEASE: boolean;

function get_property(rs: runtime.RuntimeState, jvm_key: java_object.JavaObject, _default: java_object.JavaObject = null): java_object.JavaObject {
  var key = jvm_key.jvm2js_str();
  var val = rs.jvm_state.system_properties[key];
  // special case
  if (key === 'java.class.path') {
    // the first path is actually the bootclasspath (vendor/classes/)
    return rs.init_string(val.slice(1, val.length).join(':'));
  }
  if (val != null) {
    return rs.init_string(val, true);
  } else {
    return _default;
  }
}

function unsafe_memcpy(rs: runtime.RuntimeState, src_base: java_object.JavaArray, src_offset_l: gLong, dest_base: java_object.JavaArray, dest_offset_l: gLong, num_bytes_l: gLong): void {
  // XXX assumes base object is an array if non-null
  // TODO: optimize by copying chunks at a time
  var num_bytes = num_bytes_l.toNumber();
  if (src_base != null) {
    var src_offset = src_offset_l.toNumber();
    if (dest_base != null) {
      // both are java arrays
      return java_object.arraycopy_no_check(src_base, src_offset, dest_base, dest_offset_l.toNumber(), num_bytes);
    } else {
      // src is an array, dest is a mem block
      var dest_addr = rs.block_addr(dest_offset_l);
      if (typeof DataView !== "undefined" && DataView !== null) {
        for (var i = 0; i < num_bytes; i++) {
          rs.mem_blocks[dest_addr].setInt8(i, src_base.array[src_offset + i]);
        }
      } else {
        for (var i = 0; i < num_bytes; i++) {
          rs.mem_blocks[dest_addr + i] = src_base.array[src_offset + i];
        }
      }
    }
  } else {
    var src_addr = rs.block_addr(src_offset_l);
    if (dest_base != null) {
      // src is a mem block, dest is an array
      var dest_offset = dest_offset_l.toNumber();
      if (typeof DataView !== "undefined" && DataView !== null) {
        for (var i = 0; i < num_bytes; i++) {
          dest_base.array[dest_offset + i] = rs.mem_blocks[src_addr].getInt8(i);
        }
      } else {
        for (var i = 0; i < num_bytes; i++) {
          dest_base.array[dest_offset + i] = rs.mem_blocks[src_addr + i];
        }
      }
    } else {
      // both are mem blocks
      var dest_addr = rs.block_addr(dest_offset_l);
      if (typeof DataView !== "undefined" && DataView !== null) {
        for (var i = 0; i < num_bytes; i++) {
          rs.mem_blocks[dest_addr].setInt8(i, rs.mem_blocks[src_addr].getInt8(i));
        }
      } else {
        for (var i = 0; i < num_bytes; i++) {
          rs.mem_blocks[dest_addr + i] = rs.mem_blocks[src_addr + i];
        }
      }
    }
  }
}

var trapped_methods = {
  'java/lang/ref/Reference': {
    // NOP, because we don't do our own GC and also this starts a thread?!?!?!
    '<clinit>()V': function (rs: runtime.RuntimeState): void { }
  },
  'java/lang/String': {
    // trapped here only for speed
    'hashCode()I': function (rs: runtime.RuntimeState, javaThis: java_object.JavaObject): number {
      var i: number, hash: number = javaThis.get_field(rs, 'Ljava/lang/String;hash');
      if (hash === 0) {
        var offset = javaThis.get_field(rs, 'Ljava/lang/String;offset'),
          chars = javaThis.get_field(rs, 'Ljava/lang/String;value').array,
          count = javaThis.get_field(rs, 'Ljava/lang/String;count');
        for (i = 0; i < count; i++) {
          hash = (hash * 31 + chars[offset++]) | 0;
        }
        javaThis.set_field(rs, 'Ljava/lang/String;hash', hash);
      }
      return hash;
    }
  },
  'java/lang/System': {
    'loadLibrary(Ljava/lang/String;)V': function (rs: runtime.RuntimeState, lib_name: java_object.JavaObject): void {
      var lib = lib_name.jvm2js_str();
      if (lib !== 'zip' && lib !== 'net' && lib !== 'nio' && lib !== 'awt' && lib !== 'fontmanager') {
        return rs.java_throw((<ClassData.ReferenceClassData> rs.get_bs_class('Ljava/lang/UnsatisfiedLinkError;')), "no " + lib + " in java.library.path");
      }
    },
    'getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;': get_property,
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': get_property
  },
  'java/lang/Terminator': {
    'setup()V': function (rs: runtime.RuntimeState): void {
      // XXX: We should probably fix this; we support threads now.
      // Historically: NOP'd because we didn't support threads.
    }
  },
  'java/util/concurrent/atomic/AtomicInteger': {
    '<clinit>()V': function (rs: runtime.RuntimeState): void {
      // NOP
    },
    'compareAndSet(II)Z': function (rs: runtime.RuntimeState, javaThis: java_object.JavaObject, expect: number, update: number): boolean {
      javaThis.set_field(rs, 'Ljava/util/concurrent/atomic/AtomicInteger;value', update);
      // always true, because we only have one thread of execution
      // @todo Fix: Actually check expected value!
      return true;
    }
  },
  'java/nio/Bits': {
    'byteOrder()Ljava/nio/ByteOrder;': function (rs: runtime.RuntimeState): java_object.JavaObject {
      var cls = <ClassData.ReferenceClassData> rs.get_bs_class('Ljava/nio/ByteOrder;');
      return cls.static_get(rs, 'LITTLE_ENDIAN');
    },
    'copyToByteArray(JLjava/lang/Object;JJ)V': function (rs: runtime.RuntimeState, srcAddr: gLong, dst: java_object.JavaArray, dstPos: gLong, length: gLong): void {
      unsafe_memcpy(rs, null, srcAddr, dst, dstPos, length);
    }
  },
  'java/nio/charset/Charset$3': {
    // this is trapped and NOP'ed for speed
    'run()Ljava/lang/Object;': function(rs: runtime.RuntimeState, javaThis: java_object.JavaObject): java_object.JavaObject {
      return null;
    }
  }
};

export class AbstractMethodField {
  public cls: ClassData.ReferenceClassData;
  public idx: number;
  public access_byte: number;
  public access_flags: util.Flags;
  public name: string;
  public raw_descriptor: string;
  public attrs: attributes.Attribute[];

  constructor(cls: ClassData.ReferenceClassData) {
    this.cls = cls;
  }

  public parse(bytes_array: util.BytesArray, constant_pool: ConstantPool.ConstantPool, idx: number): void {
    this.idx = idx;
    this.access_byte = bytes_array.get_uint(2);
    this.access_flags = util.parse_flags(this.access_byte);
    this.name = constant_pool.get(bytes_array.get_uint(2)).value;
    this.raw_descriptor = constant_pool.get(bytes_array.get_uint(2)).value;
    this.parse_descriptor(this.raw_descriptor);
    this.attrs = attributes.make_attributes(bytes_array, constant_pool);
  }

  public get_attribute(name: string): attributes.Attribute {
    for (var i = 0; i < this.attrs.length; i++) {
      var attr = this.attrs[i];
      if (attr.name === name) {
        return attr;
      }
    }
    return null;
  }

  public get_attributes(name: string): attributes.Attribute[] {
    return this.attrs.filter((attr) => attr.name === name);
  }

  // To satiate TypeScript. Consider it an 'abstract' method.
  public parse_descriptor(raw_descriptor: string): void {
    throw new Error("Unimplemented error.");
  }
}

export class Field extends AbstractMethodField {
  public type: string;

  public parse_descriptor(raw_descriptor: string): void {
    this.type = raw_descriptor;
  }

  // Must be called asynchronously.
  public reflector(rs: runtime.RuntimeState, success_fn: (reflectedField: java_object.JavaObject)=>void, failure_fn: (e_fn: ()=>void)=>void): void {
    var _this = this;
    var found = <attributes.Signature> this.get_attribute("Signature");
    // note: sig is the generic type parameter (if one exists), not the full
    // field type.
    var sig = (found != null) ? found.sig : null;
    function create_obj(clazz_obj: java_object.JavaClassObject, type_obj: java_object.JavaObject) {
      var field_cls = <ClassData.ReferenceClassData> rs.get_bs_class('Ljava/lang/reflect/Field;');
      return new JavaObject(rs, field_cls, {
        // XXX this leaves out 'annotations'
        'Ljava/lang/reflect/Field;clazz': clazz_obj,
        'Ljava/lang/reflect/Field;name': rs.init_string(_this.name, true),
        'Ljava/lang/reflect/Field;type': type_obj,
        'Ljava/lang/reflect/Field;modifiers': _this.access_byte,
        'Ljava/lang/reflect/Field;slot': _this.idx,
        'Ljava/lang/reflect/Field;signature': sig != null ? rs.init_string(sig) : null
      });
    };
    var clazz_obj = this.cls.get_class_object(rs);
    // type_obj may not be loaded, so we asynchronously load it here.
    // In the future, we can speed up reflection by having a synchronous_reflector
    // method that we can try first, and which may fail.
    this.cls.loader.resolve_class(rs, this.type, (function (type_cls) {
      var type_obj = type_cls.get_class_object(rs);
      var rv = create_obj(clazz_obj, type_obj);
      success_fn(rv);
    }), failure_fn);
  }
}

export class Method extends AbstractMethodField {
  private reset_caches: boolean;
  public param_types: string[];
  private param_bytes: number;
  private num_args: number;
  public return_type: string;
  // Code is either a function, or a CodeAttribute. We should have a factory method
  // that constructs NativeMethod objects and BytecodeMethod objects.
  public code: any;
  public has_bytecode: boolean;

  public parse_descriptor(raw_descriptor: string): void {
    this.reset_caches = false;  // Switched to 'true' in web frontend between JVM invocations.
    var match = /\(([^)]*)\)(.*)/.exec(raw_descriptor);
    var param_str = match[1];
    var return_str = match[2];
    var param_carr = param_str.split('');
    this.param_types = [];
    var field;
    while (field = util.carr2descriptor(param_carr)) {
      this.param_types.push(field);
    }
    this.param_bytes = 0;
    for (var i = 0; i < this.param_types.length; i++) {
      var p = this.param_types[i];
      this.param_bytes += (p === 'D' || p === 'J') ? 2 : 1;
    }
    if (!this.access_flags["static"]) {
      this.param_bytes++;
    }
    this.num_args = this.param_types.length;
    if (!this.access_flags["static"]) {
      // nonstatic methods get 'this'
      this.num_args++;
    }
    this.return_type = return_str;
  }

  public full_signature(): string {
    return this.cls.get_type() + "::" + this.name + this.raw_descriptor;
  }

  public parse(bytes_array: util.BytesArray, constant_pool: ConstantPool.ConstantPool, idx: number): void {
    super.parse(bytes_array, constant_pool, idx);
    var sig = this.full_signature(),
      clsName = this.cls.get_type(),
      methSig = this.name + this.raw_descriptor,
      c: Function;

    if (trapped_methods[clsName] && ((c = trapped_methods[clsName][methSig]) != null)) {
      this.code = c;
      this.access_flags["native"] = true;
    } else if (this.access_flags["native"]) {
      if (sig.indexOf('::registerNatives()V', 1) < 0 && sig.indexOf('::initIDs()V', 1) < 0) {
        this.code = function (rs: runtime.RuntimeState) {
          // Try to fetch the native method.
          var c = rs.getNative(clsName, methSig);
          if (c == null) {
            rs.java_throw(<ClassData.ReferenceClassData>
              rs.get_bs_class('Ljava/lang/UnsatisfiedLinkError;'),
              "Native method '" + sig + "' not implemented.\nPlease fix or file a bug at https://github.com/int3/doppio/issues");
          } else {
            this.code = c;
            c.apply(this, arguments);
          }
        };
      } else {
        // micro-optimization for registerNatives and initIDs, don't even bother making a function
        this.code = null;
      }
    } else if (!this.access_flags.abstract) {
      this.has_bytecode = true;
      this.code = this.get_attribute('Code');
    }
  }

  public reflector(rs: runtime.RuntimeState, is_constructor: boolean, success_fn: (reflectedMethod: java_object.JavaObject)=>void, failure_fn: (e_fn: ()=>void)=>void): void {
    var _ref3, _ref4, _ref5, _ref6, _ref7, _this = this;

    if (is_constructor == null) {
      is_constructor = false;
    }
    var typestr = is_constructor ? 'Ljava/lang/reflect/Constructor;' : 'Ljava/lang/reflect/Method;';
    var exceptions = (_ref3 = (_ref4 = this.get_attribute("Exceptions")) != null ? _ref4.exceptions : void 0) != null ? _ref3 : [];
    var anns = (_ref5 = this.get_attribute("RuntimeVisibleAnnotations")) != null ? _ref5.raw_bytes : void 0;
    var adefs = (_ref6 = this.get_attribute("AnnotationDefault")) != null ? _ref6.raw_bytes : void 0;
    var sig = (_ref7 = this.get_attribute("Signature")) != null ? _ref7.sig : void 0;
    var obj = {};
    var clazz_obj = this.cls.get_class_object(rs);
    this.cls.loader.resolve_class(rs, this.return_type, (function (rt_cls) {
      var rt_obj = rt_cls.get_class_object(rs);
      var j = -1;
      var etype_objs: java_object.JavaClassObject[] = [];
      var i = -1;
      var param_type_objs: java_object.JavaClassObject[] = [];
      var k = 0;
      var handlers;
      if (_this.code != null && _this.code.exception_handlers != null && _this.code.exception_handlers.length > 0) {
        // HotSpot seems to do this
        handlers = [{catch_type: 'Ljava/lang/Throwable;'}];
        Array.prototype.push.apply(handlers, _this.code.exception_handlers);
      } else {
        handlers = [];
      }
      function fetch_catch_type() {
        if (k < handlers.length) {
          var eh = handlers[k++];
          if (eh.catch_type === '<any>') {
            return fetch_catch_type();
          }
          return _this.cls.loader.resolve_class(rs, eh.catch_type, fetch_catch_type, failure_fn);
        } else {
          return fetch_ptype();
        }
      };
      function fetch_etype() {
        j++;
        if (j < exceptions.length) {
          var e_desc = exceptions[j];
          return _this.cls.loader.resolve_class(rs, e_desc, (function (cls) {
            etype_objs[j] = cls.get_class_object(rs);
            return fetch_etype();
          }), failure_fn);
        } else {
          // XXX: missing parameterAnnotations
          var jco_arr_cls = <ClassData.ArrayClassData> rs.get_bs_class('[Ljava/lang/Class;');
          var byte_arr_cls = <ClassData.ArrayClassData> rs.get_bs_class('[B');
          var cls = <ClassData.ReferenceClassData> rs.get_bs_class(typestr);
          obj[typestr + 'clazz'] = clazz_obj;
          obj[typestr + 'name'] = rs.init_string(_this.name, true);
          obj[typestr + 'parameterTypes'] = new JavaArray(rs, jco_arr_cls, param_type_objs);
          obj[typestr + 'returnType'] = rt_obj;
          obj[typestr + 'exceptionTypes'] = new JavaArray(rs, jco_arr_cls, etype_objs);
          obj[typestr + 'modifiers'] = _this.access_byte;
          obj[typestr + 'slot'] = _this.idx;
          obj[typestr + 'signature'] = sig != null ? rs.init_string(sig) : null;
          obj[typestr + 'annotations'] = anns != null ? new JavaArray(rs, byte_arr_cls, anns) : null;
          obj[typestr + 'annotationDefault'] = adefs != null ? new JavaArray(rs, byte_arr_cls, adefs) : null;
          return success_fn(new JavaObject(rs, cls, obj));
        }
      };
      function fetch_ptype() {
        i++;
        if (i < _this.param_types.length) {
          return _this.cls.loader.resolve_class(rs, _this.param_types[i], (function (cls) {
            param_type_objs[i] = cls.get_class_object(rs);
            return fetch_ptype();
          }), failure_fn);
        } else {
          return fetch_etype();
        }
      };
      return fetch_catch_type();
    }), failure_fn);
  }

  public take_params(caller_stack: any[]): any[] {
    var start = caller_stack.length - this.param_bytes;
    var params = caller_stack.slice(start);
    // this is faster than splice()
    caller_stack.length -= this.param_bytes;
    return params;
  }

  public convert_params(rs: runtime.RuntimeState, params: any[]): any[] {
    var converted_params = [rs];
    var param_idx = 0;
    if (!this.access_flags["static"]) {
      converted_params.push(params[0]);
      param_idx = 1;
    }
    for (var i = 0; i < this.param_types.length; i++) {
      var p = this.param_types[i];
      converted_params.push(params[param_idx]);
      param_idx += (p === 'J' || p === 'D') ? 2 : 1;
    }
    return converted_params;
  }

  public run_manually(func: Function, rs: runtime.RuntimeState, converted_params: any[]): void {
    trace("entering native method " + this.full_signature());
    var rv: any;
    try {
      rv = func.apply(null, converted_params);
    } catch (_error) {
      var e = _error;
      if (e === ReturnException) {
        return;
      }
      throw e;
    }
    rs.meta_stack().pop();
    var ret_type = this.return_type;
    if (ret_type !== 'V') {
      if (ret_type === 'Z') {
        rs.push(rv + 0);
      } else {
        rs.push(rv);
      }
      if (ret_type === 'J' || ret_type === 'D') {
        rs.push(null);
      }
    }
  }

  // Reinitializes the method by removing all cached information from the method.
  // We amortize the cost by doing it lazily the first time that we call run_bytecode.
  public initialize(): void {
    this.reset_caches = true;
  }

  public method_lock(rs: runtime.RuntimeState): any {
    if (this.access_flags["static"]) {
      return this.cls.get_class_object(rs);
    } else {
      return rs.cl(0);
    }
  }

  public run_bytecode(rs: runtime.RuntimeState): void {
    trace("entering method " + this.full_signature());
    // main eval loop: execute each opcode, using the pc to iterate through
    var code = this.code.opcodes;
    if (this.reset_caches) {
      for (var i = 0; i < code.length; i++) {
        var instr = code[i];
        if (instr != null) {
          instr.reset_cache();
        }
      }
    }
    var cf = rs.curr_frame();
    if (this.access_flags.synchronized && cf.pc === 0) {
      // hack in a monitorenter, which will yield if it fails
      if (!opcodes.monitorenter(rs, this.method_lock(rs))) {
        cf.pc = 0;
        return;
      }
    }
    // Bootstrap the loop.
    var op = code[cf.pc];
    while (!rs.should_return) {
      var annotation: string;
      if (!((typeof RELEASE !== "undefined" && RELEASE !== null) || logging.log_level < logging.VTRACE)) {
        var pc = cf.pc;
        if (!op) {
          throw this.name + ":" + pc + " => (null)";
        }
        annotation = op.annotate(pc, this.cls.constant_pool);
      }
      if (op.execute(rs) === false) {
        break;
      }
      if (!((typeof RELEASE !== "undefined" && RELEASE !== null) || logging.log_level < logging.VTRACE)) {
        vtrace(this.cls.get_type() + "::" + this.name + ":" + pc + " => " + op.name + annotation);
        var depth = rs.meta_stack().length();
        vtrace("D: " + depth + ", S: [" + debug_vars(cf.stack) + "], L: [" + debug_vars(cf.locals) + "], T: " + (!rs.curr_thread.fake ? rs.curr_thread.name(rs) : ""));
      }
      cf.pc += 1 + op.byte_count;
      op = code[cf.pc];
    }
    rs.should_return = false;
  }

  public setup_stack(runtime_state: runtime.RuntimeState): threading.StackFrame {
    var sf: threading.StackFrame;
    var _this = this;

    var ms = runtime_state.meta_stack();
    var caller_stack = runtime_state.curr_frame().stack;
    var params = this.take_params(caller_stack);
    if (this.access_flags["native"]) {
      if (this.code != null) {
        ms.push(sf = new threading.StackFrame(this, [], []));
        var c_params = this.convert_params(runtime_state, params);
        sf.runner = function () {
          return _this.run_manually(_this.code, runtime_state, c_params);
        };
        return sf;
      }
      return null;
    }
    if (this.access_flags.abstract) {
      var err_cls = <ClassData.ReferenceClassData> runtime_state.get_bs_class('Ljava/lang/Error;');
      runtime_state.java_throw(err_cls, "called abstract method: " + this.full_signature());
    }
    // Finally, the normal case: running a Java method
    ms.push(sf = new threading.StackFrame(this, params, []));
    if (this.code.run_stamp < runtime_state.run_stamp) {
      this.code.run_stamp = runtime_state.run_stamp;
      this.code.parse_code();
      if (this.access_flags.synchronized) {
        // hack in a monitorexit for all return opcodes
        for (var i in this.code.opcodes) {
          if (this.code.opcodes.hasOwnProperty(i)) {
            var c = this.code.opcodes[i];
            if (c.name.match(/^[ildfa]?return$/)) {
              (function (c: opcodes.Opcode) {
                c.execute = function (rs: runtime.RuntimeState) {
                  opcodes.monitorexit(rs, _this.method_lock(rs));
                  return c.orig_execute(rs);
                };
              })(c);
            }
          }
        }
      }
    }
    sf.runner = () => _this.run_bytecode(runtime_state);
    return sf;
  }
}
