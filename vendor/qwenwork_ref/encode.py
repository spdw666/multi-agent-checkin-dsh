"""QwenWork 1.0.4 infer body encoding via official qoder_auth_wasm.

`prepareInferRequest` rewrites the chat URL with Encode=1 and replaces the
JSON body with the WASM-encoded payload. Chat must send that body as-is.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from qwenwork_ref import cosy
from qwenwork_ref.constants import (
    BUSINESS_PRODUCT,
    BUSINESS_TYPE,
    CLIENT_TYPE,
    COSY_VERSION,
    GATEWAY,
    SCENE,
)

WASM_PATH = Path(os.environ["QWENWORK_WASM"]) if os.environ.get("QWENWORK_WASM") else Path(__file__).resolve().parent / "native" / "qoder_auth_wasm_bg.wasm"
_IMPORT_MODULE = "./qoder_auth_wasm_bg.js"
_RESERVED = 1028
_lock = threading.Lock()
_runtime: "_Wasm" | None = None


class EncodeError(RuntimeError):
    pass


@dataclass
class PreparedInfer:
    url: str
    headers: dict[str, str]
    body: str


class _Heap:
    def __init__(self) -> None:
        self.items: list[Any] = [None] * 1024 + [None, None, True, False]
        self.free = len(self.items)

    def add(self, value: Any) -> int:
        if self.free == len(self.items):
            self.items.append(len(self.items) + 1)
        idx = self.free
        nxt = self.items[idx]
        self.free = nxt if isinstance(nxt, int) else len(self.items)
        self.items[idx] = value
        return idx

    def get(self, idx: int) -> Any:
        return self.items[idx]

    def drop(self, idx: int) -> Any:
        value = self.items[idx]
        if idx >= _RESERVED:
            self.items[idx] = self.free
            self.free = idx
        return value


class _Wasm:
    def __init__(self, wasm_path: Path) -> None:
        from wasmtime import Engine, FuncType, Linker, Module, Store, ValType

        if not wasm_path.is_file():
            raise EncodeError(f"missing wasm codec: {wasm_path}")
        self.engine = Engine()
        self.store = Store(self.engine)
        self.heap = _Heap()
        self._global = {"crypto": object(), "process": {"versions": {"node": "22.0.0"}}}
        module = Module.from_file(self.engine, str(wasm_path))
        linker = Linker(self.engine)
        i32 = ValType.i32()
        f64 = ValType.f64()

        def define(name: str, params: list, results: list, fn) -> None:
            linker.define_func(_IMPORT_MODULE, name, FuncType(params, results), fn)

        define("__wbindgen_object_drop_ref", [i32], [], self._drop)
        define("__wbindgen_object_clone_ref", [i32], [i32], self._clone)
        define("__wbg_set_08463b1df38a7e29", [i32, i32, i32], [i32], self._map_set)
        define("__wbg_new_99cabae501c0a8a0", [], [i32], self._map_new)
        define("__wbg_now_88621c9c9a4f3ffc", [], [f64], lambda: time.time() * 1000.0)
        define("__wbg_getRandomValues_d49329ff89a07af1", [i32, i32], [], self._fill_memory)
        define("__wbg_getRandomValues_c44a50d8cfdaebeb", [i32, i32], [], self._fill_obj)
        define("__wbg_randomFillSync_6c25eac9869eb53c", [i32, i32], [], self._fill_obj)
        define("__wbg_crypto_38df2bab126b63dc", [i32], [i32], lambda idx: self.heap.add(self._global["crypto"]))
        define("__wbg_msCrypto_bd5a034af96bcba6", [i32], [i32], lambda idx: self.heap.add(None))
        define("__wbg_process_44c7a14e11e9f69e", [i32], [i32], lambda idx: self.heap.add(self._global["process"]))
        define("__wbg_versions_276b2795b1c6a219", [i32], [i32], lambda idx: self.heap.add(self._global["process"]["versions"]))
        define("__wbg_node_84ea875411254db1", [i32], [i32], lambda idx: self.heap.add("22.0.0"))
        define("__wbg_require_b4edbdcf3e2a1ef0", [], [i32], lambda: self.heap.add(None))
        define("__wbg_call_d578befcc3145dee", [i32, i32, i32], [i32], self._call)
        define("__wbg_new_with_length_9cedd08484b73942", [i32], [i32], lambda n: self.heap.add(bytearray(n & 0xFFFFFFFF)))
        define("__wbg_length_0c32cb8543c8e4c8", [i32], [i32], self._length)
        define("__wbg_prototypesetcall_3e05eb9545565046", [i32, i32, i32], [], self._mem_set)
        define("__wbg_subarray_0f98d3fb634508ad", [i32, i32, i32], [i32], self._subarray)
        define("__wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f", [], [i32], lambda: self.heap.add(self._global))
        define("__wbg_static_accessor_SELF_24f78b6d23f286ea", [], [i32], lambda: 0)
        define("__wbg_static_accessor_GLOBAL_f2e0f995a21329ff", [], [i32], lambda: 0)
        define("__wbg_static_accessor_WINDOW_59fd959c540fe405", [], [i32], lambda: 0)
        define("__wbg___wbindgen_throw_81fc77679af83bc6", [i32, i32], [], self._throw)
        define("__wbg_Error_2e59b1b37a9a34c3", [i32, i32], [i32], self._error)
        define("__wbg___wbindgen_is_object_40c5a80572e8f9d3", [i32], [i32], self._is_object)
        define("__wbg___wbindgen_is_string_b29b5c5a8065ba1a", [i32], [i32], lambda idx: int(isinstance(self.heap.get(idx), str)))
        define("__wbg___wbindgen_is_function_49868bde5eb1e745", [i32], [i32], lambda idx: int(callable(self.heap.get(idx))))
        define("__wbg___wbindgen_is_undefined_c0cca72b82b86f4d", [i32], [i32], lambda idx: int(self.heap.get(idx) is None))
        define("__wbindgen_cast_0000000000000001", [i32, i32], [i32], lambda ptr, length: self.heap.add(("view", ptr, length)))
        define("__wbindgen_cast_0000000000000002", [i32, i32], [i32], lambda ptr, length: self.heap.add(self._read_str(ptr, length)))

        self.instance = linker.instantiate(self.store, module)
        exports = self.instance.exports(self.store)
        self.memory = exports["memory"]
        self.ex = exports

    def _memory(self) -> memoryview:
        return self.memory.data_ptr(self.store)

    def _read_str(self, ptr: int, length: int) -> str:
        buf = self.memory.read(self.store, ptr, ptr + length)
        return bytes(buf).decode("utf-8")

    def _write_str(self, text: str, malloc, realloc=None) -> tuple[int, int]:
        data = text.encode("utf-8")
        ptr = malloc(self.store, len(data), 1)
        self.memory.write(self.store, data, ptr)
        return ptr, len(data)

    def _drop(self, idx: int) -> None:
        self.heap.drop(idx)

    def _clone(self, idx: int) -> int:
        return self.heap.add(self.heap.get(idx))

    def _map_new(self) -> int:
        return self.heap.add({})

    def _map_set(self, map_idx: int, key_idx: int, val_idx: int) -> int:
        mapping = self.heap.get(map_idx)
        if not isinstance(mapping, dict):
            mapping = {}
            self.heap.items[map_idx] = mapping
        mapping[self.heap.get(key_idx)] = self.heap.get(val_idx)
        return self.heap.add(mapping)

    def _fill_memory(self, ptr: int, length: int) -> None:
        blob = os.urandom(length)
        self.memory.write(self.store, blob, ptr)

    def _fill_obj(self, _obj_idx: int, view_idx: int) -> None:
        view = self.heap.get(view_idx)
        if isinstance(view, bytearray):
            view[:] = os.urandom(len(view))
        elif isinstance(view, tuple) and view[0] == "view":
            _, ptr, length = view
            self.memory.write(self.store, os.urandom(length), ptr)

    def _call(self, fn_idx: int, this_idx: int, arg_idx: int) -> int:
        fn = self.heap.get(fn_idx)
        if not callable(fn):
            return self.heap.add(None)
        return self.heap.add(fn(self.heap.get(this_idx), self.heap.get(arg_idx)))

    def _length(self, idx: int) -> int:
        value = self.heap.get(idx)
        if isinstance(value, (bytes, bytearray, str, list, dict, tuple)):
            if isinstance(value, tuple) and value and value[0] == "view":
                return int(value[2])
            return len(value)
        return 0

    def _mem_set(self, ptr: int, length: int, src_idx: int) -> None:
        src = self.heap.get(src_idx)
        if isinstance(src, tuple) and src and src[0] == "view":
            _, sptr, slen = src
            data = bytes(self.memory.read(self.store, sptr, sptr + slen))
        elif isinstance(src, (bytes, bytearray, memoryview)):
            data = bytes(src)
        else:
            return
        self.memory.write(self.store, data[:length], ptr)

    def _subarray(self, idx: int, start: int, end: int) -> int:
        value = self.heap.get(idx)
        if isinstance(value, tuple) and value and value[0] == "view":
            _, ptr, _ = value
            return self.heap.add(("view", ptr + start, end - start))
        if isinstance(value, (bytes, bytearray)):
            return self.heap.add(value[start:end])
        return self.heap.add(None)

    def _throw(self, ptr: int, length: int) -> None:
        raise EncodeError(self._read_str(ptr, length))

    def _error(self, ptr: int, length: int) -> int:
        return self.heap.add(EncodeError(self._read_str(ptr, length)))

    def _is_object(self, idx: int) -> int:
        value = self.heap.get(idx)
        return int(value is not None and not isinstance(value, (str, int, float, bool)))

    def _pass_str(self, text: str) -> tuple[int, int]:
        malloc = self.ex["__wbindgen_export2"]
        data = text.encode("utf-8")
        # Python counts emoji as one code point; JS glue counts two UTF-16 units.
        # Allocate the actual UTF-8 bytes rather than copying JS's 3*length shortcut.
        ptr = malloc(self.store, len(data), 1)
        self.memory.write(self.store, data, ptr)
        return ptr, len(data)

    def _stack_i32(self, retptr: int, offset: int) -> int:
        buf = bytes(self.memory.read(self.store, retptr + offset, retptr + offset + 4))
        return int.from_bytes(buf, "little", signed=True)

    def _add_sp(self, delta: int) -> int:
        return int(self.ex["__wbindgen_add_to_stack_pointer"](self.store, delta))

    def _dealloc_str(self, ptr: int, length: int) -> None:
        self.ex["__wbindgen_export4"](self.store, ptr, length, 1)

    def context_new(self, machine_id: str, cosy_version: str, user_info: str, brand: str) -> int:
        ret = self._add_sp(-16)
        try:
            p1, n1 = self._pass_str(machine_id)
            p2, n2 = self._pass_str(cosy_version)
            p3, n3 = self._pass_str(user_info)
            p4, n4 = self._pass_str(brand) if brand else (0, 0)
            self.ex["qodercontext_new"](self.store, ret, p1, n1, p2, n2, p3, n3, p4, n4)
            ptr = self._stack_i32(ret, 0)
            err = self._stack_i32(ret, 4)
            flag = self._stack_i32(ret, 8)
            if flag:
                value = self.heap.drop(err)
                raise value if isinstance(value, Exception) else EncodeError(str(value))
            return ptr
        finally:
            self._add_sp(16)

    def prepare_infer(self, ctx: int, endpoint: str, body: str, model_key: str, source: str) -> PreparedInfer:
        ret = self._add_sp(-16)
        try:
            p1, n1 = self._pass_str(endpoint)
            p2, n2 = self._pass_str(body)
            p3, n3 = (self._pass_str(model_key) if model_key else (0, 0))
            p4, n4 = (self._pass_str(source) if source else (0, 0))
            self.ex["qodercontext_prepareInferRequest"](
                self.store, ret, ctx, p1, n1, p2, n2, p3, n3, p4, n4
            )
            ptr = self._stack_i32(ret, 0)
            err = self._stack_i32(ret, 4)
            flag = self._stack_i32(ret, 8)
            if flag:
                value = self.heap.drop(err)
                raise value if isinstance(value, Exception) else EncodeError(str(value))
            return self._read_result(ptr)
        finally:
            self._add_sp(16)

    def prepare_request(
        self,
        ctx: int,
        endpoint: str,
        path: str,
        method: str,
        mode: str = "auth",
        body: str | None = None,
    ) -> PreparedInfer:
        ret = self._add_sp(-16)
        try:
            p1, n1 = self._pass_str(endpoint)
            p2, n2 = self._pass_str(path)
            p3, n3 = self._pass_str(method)
            p4, n4 = self._pass_str(mode)
            p5, n5 = (self._pass_str(body) if body else (0, 0))
            self.ex["qodercontext_prepareRequest"](
                self.store, ret, ctx, p1, n1, p2, n2, p3, n3, p4, n4, p5, n5, 0, 0
            )
            ptr = self._stack_i32(ret, 0)
            err = self._stack_i32(ret, 4)
            flag = self._stack_i32(ret, 8)
            if flag:
                value = self.heap.drop(err)
                raise value if isinstance(value, Exception) else EncodeError(str(value))
            return self._read_result(ptr)
        finally:
            self._add_sp(16)

    def _read_result(self, ptr: int) -> PreparedInfer:
        ret = self._add_sp(-16)
        try:
            self.ex["requestresult_url"](self.store, ret, ptr)
            uptr = self._stack_i32(ret, 0)
            ulen = self._stack_i32(ret, 4)
            url = self._read_str(uptr, ulen)
            self._dealloc_str(uptr, ulen)
        finally:
            self._add_sp(16)
        headers_idx = int(self.ex["requestresult_headers"](self.store, ptr))
        headers_obj = self.heap.drop(headers_idx)
        headers: dict[str, str] = {}
        if isinstance(headers_obj, dict):
            headers = {str(k): str(v) for k, v in headers_obj.items()}
        ret = self._add_sp(-16)
        body = ""
        try:
            self.ex["requestresult_body"](self.store, ret, ptr)
            bptr = self._stack_i32(ret, 0)
            blen = self._stack_i32(ret, 4)
            if bptr:
                body = self._read_str(bptr, blen)
                self._dealloc_str(bptr, blen)
        finally:
            self._add_sp(16)
        self.ex["__wbg_requestresult_free"](self.store, ptr, 0)
        return PreparedInfer(url=url, headers=headers, body=body)

    def context_free(self, ctx: int) -> None:
        self.ex["__wbg_qodercontext_free"](self.store, ctx, 0)


def _runtime_get() -> _Wasm:
    global _runtime
    with _lock:
        if _runtime is None:
            _runtime = _Wasm(WASM_PATH)
        return _runtime


def prepare_infer(
    *,
    body: str,
    model_key: str,
    source: str = "system",
    machine_id: str = "",
    uid: str = "",
    name: str = "",
    email: str = "",
    access_token: str = "",
    endpoint: str = GATEWAY,
) -> PreparedInfer:
    material = cosy.encrypt_user_info(
        uid=uid, name=name, email=email, access_token=access_token
    )
    user_info = json.dumps(
        {
            "uid": uid or "",
            "encrypt_user_info": material["info"],
            "key": material["key"],
            "organization_id": "",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    brand = json.dumps(
        {
            "client_type": CLIENT_TYPE,
            "business_product": BUSINESS_PRODUCT,
            "business_type": BUSINESS_TYPE,
            "scene": SCENE,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    wasm = _runtime_get()
    with _lock:
        ctx = wasm.context_new(machine_id or "buddy2api", COSY_VERSION, user_info, brand)
        try:
            return wasm.prepare_infer(ctx, endpoint, body, model_key, source)
        finally:
            wasm.context_free(ctx)
