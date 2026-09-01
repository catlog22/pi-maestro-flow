#!/usr/bin/env python3
"""Fixed-argv Windows UI Automation helper for pi-maestro-flow.

The Node adapter invokes this file with one bounded action and reads one JSON
line. It intentionally has no shell, network, or arbitrary-code interface.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import sys
import uuid
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)


def configure_dpi_awareness() -> None:
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


def load_window_dependency() -> tuple[Any, str | None]:
    try:
        import win32gui
    except Exception as exc:
        return None, f"pywin32 unavailable: {exc}"
    configure_dpi_awareness()
    return win32gui, None


def load_accessibility_dependencies() -> tuple[Any, Any, str | None]:
    try:
        import pywinauto
        from pywinauto import Desktop
    except Exception as exc:
        return None, None, f"pywinauto unavailable: {exc}"
    configure_dpi_awareness()
    return pywinauto, Desktop, None


def rect_dict(rect: Any) -> dict[str, int] | None:
    try:
        left, top, right, bottom = int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception:
        return None
    return {"x": left, "y": top, "width": max(0, right - left), "height": max(0, bottom - top)}


def window_info(win32gui: Any, hwnd: int) -> dict[str, Any]:
    if not win32gui.IsWindow(hwnd):
        raise ValueError(f"invalid window handle: {hwnd}")
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    client_left, client_top, client_right, client_bottom = win32gui.GetClientRect(hwnd)
    screen_left, screen_top = win32gui.ClientToScreen(hwnd, (0, 0))
    foreground = int(win32gui.GetForegroundWindow()) == hwnd
    return {
        "bounds": {"x": int(left), "y": int(top), "width": max(0, int(right - left)), "height": max(0, int(bottom - top))},
        "clientBounds": {
            "x": int(screen_left),
            "y": int(screen_top),
            "width": max(0, int(client_right - client_left)),
            "height": max(0, int(client_bottom - client_top)),
        },
        "active": foreground,
    }


def control_info(wrapper: Any, hwnd: int, path: list[int]) -> dict[str, Any]:
    element = getattr(wrapper, "element_info", None)
    name = None
    role = None
    identifier = None
    value: Any = None
    try:
        name = getattr(element, "name", None) or wrapper.window_text() or None
    except Exception:
        pass
    try:
        role = getattr(element, "control_type", None) or wrapper.friendly_class_name()
    except Exception:
        role = "unknown"
    try:
        identifier = getattr(element, "automation_id", None) or None
    except Exception:
        pass
    try:
        value = getattr(element, "value", None)
    except Exception:
        value = None
    try:
        enabled = bool(wrapper.is_enabled())
    except Exception:
        enabled = None
    try:
        focused = bool(wrapper.has_focus())
    except Exception:
        focused = None
    try:
        offscreen = not bool(wrapper.is_visible())
    except Exception:
        offscreen = None

    actions: list[str] = []
    for method, action in (("invoke", "invoke"), ("select", "select"), ("toggle", "toggle"), ("click_input", "click")):
        if callable(getattr(wrapper, method, None)):
            actions.append(action)

    return {
        "ref": f"uia:{hwnd}:{','.join(str(i) for i in path) if path else 'root'}",
        "role": str(role or "unknown"),
        "name": name,
        "title": name,
        "identifier": identifier,
        "value": value if isinstance(value, (str, int, float, bool)) or value is None else str(value),
        "enabled": enabled,
        "focused": focused,
        "offscreen": offscreen,
        "bounds": rect_dict(wrapper.rectangle()),
        "actions": actions,
        "windowId": str(hwnd),
    }


def collect_controls(desktop_factory: Any, hwnd: int, max_depth: int, include_offscreen: bool) -> list[dict[str, Any]]:
    root = desktop_factory(backend="uia").window(handle=hwnd)
    controls: list[dict[str, Any]] = []
    max_nodes = 2000

    def walk(wrapper: Any, path: list[int], depth: int) -> None:
        if len(controls) >= max_nodes:
            return
        try:
            info = control_info(wrapper, hwnd, path)
        except Exception:
            info = None
        if info is not None and (include_offscreen or info["offscreen"] is not True):
            controls.append(info)
        if depth >= max_depth:
            return
        try:
            children = wrapper.children()
        except Exception:
            return
        for index, child in enumerate(children):
            walk(child, path + [index], depth + 1)
            if len(controls) >= max_nodes:
                return

    walk(root, [], 0)
    return controls


def wrapper_for_ref(desktop_factory: Any, hwnd: int, ref: str) -> Any:
    prefix = f"uia:{hwnd}:"
    if not ref.startswith(prefix):
        raise ValueError("control reference belongs to another window")
    raw_path = ref[len(prefix):]
    root = desktop_factory(backend="uia").window(handle=hwnd)
    if raw_path == "root":
        return root
    path = [int(part) for part in raw_path.split(",") if part != ""]
    wrapper = root
    for index in path:
        children = wrapper.children()
        if index < 0 or index >= len(children):
            raise ValueError("control reference is stale")
        wrapper = children[index]
    return wrapper


def press_control(desktop_factory: Any, hwnd: int, ref: str) -> str:
    wrapper = wrapper_for_ref(desktop_factory, hwnd, ref)
    for method in ("invoke", "select", "toggle"):
        action = getattr(wrapper, method, None)
        if callable(action):
            action()
            return "semantic"
    click = getattr(wrapper, "click_input", None)
    if callable(click):
        click()
        return "physical_fallback"
    raise ValueError("control has no supported invoke action")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--action", required=True, choices=("probe", "window", "ui-tree", "press-control"))
    parser.add_argument("--hwnd", type=int)
    parser.add_argument("--ref")
    parser.add_argument("--max-depth", type=int, default=8)
    parser.add_argument("--include-offscreen", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.hwnd is None and args.action != "probe":
        emit({"ok": False, "code": "INVALID_INPUT", "message": "--hwnd is required"})
        return
    if args.action == "window":
        win32gui, error = load_window_dependency()
        if error:
            emit({"ok": False, "code": "DEPENDENCY_UNAVAILABLE", "message": error, "missing": ["pywin32"]})
            return
        try:
            emit({"ok": True, **window_info(win32gui, args.hwnd)})
        except Exception as exc:
            emit({"ok": False, "code": "UIA_OPERATION_FAILED", "message": str(exc)})
        return

    pywinauto, desktop_factory, error = load_accessibility_dependencies()
    if error:
        emit({"ok": False, "code": "DEPENDENCY_UNAVAILABLE", "message": error, "missing": ["pywinauto"]})
        return
    if args.action == "probe":
        emit({"ok": True, "provider": "pywinauto-uia", "version": getattr(pywinauto, "__version__", None)})
        return
    try:
        if args.action == "ui-tree":
            if args.max_depth < 0 or args.max_depth > 32:
                raise ValueError("max depth must be between 0 and 32")
            emit({
                "ok": True,
                "snapshotId": f"uia-{uuid.uuid4().hex[:16]}",
                "controls": collect_controls(desktop_factory, args.hwnd, args.max_depth, args.include_offscreen),
            })
        else:
            if not args.ref:
                raise ValueError("--ref is required")
            method = press_control(desktop_factory, args.hwnd, args.ref)
            emit({"ok": True, "method": method})
    except Exception as exc:
        emit({"ok": False, "code": "UIA_OPERATION_FAILED", "message": str(exc)})


if __name__ == "__main__":
    main()
