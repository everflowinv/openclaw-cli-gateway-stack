"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { upstreamToolSelected: selected } = require("./upstream-selection.cjs");

test("unconfigured legacy bridge and independent tools remain available", () => {
  assert.equal(selected(undefined, "search_library"), true);
  assert.equal(selected({toolFilter:{exclude:["search_library"]}}, "search_events"), true);
});
test("duplicate research tools are removed while unique functions survive", () => {
  const entry = {toolFilter:{exclude:["search_library","get_document","auth_status","list_filters"]}};
  assert.equal(selected(entry,"get_document"), false);
  assert.equal(selected(entry,"download_document"), true);
});
test("exclude wins over include", () => {
  const entry = {toolFilter:{include:["search_*"],exclude:["search_library"]}};
  assert.equal(selected(entry,"search_library"), false);
  assert.equal(selected(entry,"search_events"), true);
  assert.equal(selected(entry,"register_event"), false);
});
test("disabled servers and empty include expose nothing", () => {
  assert.equal(selected({enabled:false},"search_library"), false);
  assert.equal(selected({toolFilter:{include:[]}},"search_library"), false);
});
test("patterns treat regexp punctuation as literal", () => {
  assert.equal(selected({toolFilter:{include:["a.b*"]}},"axb_name"), false);
  assert.equal(selected({toolFilter:{include:["a.b*"]}},"a.b_name"), true);
});
