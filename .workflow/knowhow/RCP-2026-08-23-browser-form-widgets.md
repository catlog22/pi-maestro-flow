---
title: Rich-text editors, custom dropdowns/typeahead, date pickers, drag & drop
type: recipe
tools: [browser]
sop_topic: form-widgets
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Complex form controls — custom widgets that resist fill()/click().

CONTENTEDITABLE RICH TEXT (ProseMirror/Slate/Quill/Jodit/Lark editor)
- Focus the editor BEFORE setting text: fill()/value writes APPEND instead of replace when the element is not focused.
- These are not <input>: "Element is not an input" means click into the editor, then type with real key events; for structured content dispatch paste events with a text/html payload.

CUSTOM DROPDOWNS / COMBOBOXES (antd Select, react-select, typeahead)
- There are no native <option>s: click the trigger to open the listbox, then click the rendered option — overlays are usually portaled to document.body, so scope queries globally, not inside the form subtree.
- Typeahead: type to filter, WAIT for options to render, then click; assert the chosen value shows in the trigger afterwards.

DATE PICKERS
- Prefer typing over calendar-walking where allowed: focus the input, type the full date, press Enter (antd RangePicker pattern). Calendar-walking breaks across month/year boundaries.

DRAG & DROP
- HTML5 DnD ignores plain clicks: use CDP Input mouse primitives (move -> press -> move over target with hover dwell -> release) or dispatch synthetic dragstart/dragover/drop with ONE shared DataTransfer carrying the payload.

GENERAL
- Component libraries (antd/MUI/arco) hide real inputs behind styled divs — locate by label text then traverse, and verify the FRAMEWORK state (form value, chip, tag) changed, not just CSS classes.

