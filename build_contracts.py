"""Generate the v0.1 design draft's illustrative contracts and fixtures.
This is not an Ariadne implementation and does not call a model or desktop API.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def obj(properties, required=None, **extra):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False, **extra}

def arr(items, **kw):
    return {"type": "array", "items": items, **kw}

def ref(name):
    return {"$ref": f"#/$defs/{name}"}

def enum(*values):
    return {"enum": list(values)}

ID = {"type": "string", "minLength": 1, "maxLength": 128,
      "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"}
TEXT = {"type": "string", "maxLength": 65536}
SMALL = {"type": "string", "minLength": 1, "maxLength": 4096}
UINT = {"type": "integer", "minimum": 0}
POS = {"type": "integer", "minimum": 1}
PROB = {"type": "number", "minimum": 0, "maximum": 1}


def tagged(kind, props, **extra):
    return obj({"kind": {"const": kind}, "schemaVersion": {"const": "0.1"}, **props}, **extra)


def attribute(value_schema):
    return {"oneOf": [
        obj({"status": {"const": "available"}, "value": value_schema}),
        obj({"status": enum("unavailable", "unsupported", "redacted", "error")})
    ]}

D = {}
# One source for browser read/output limits, their runtime checks, and the wire schema.
# Defaults are validated against real-page measurements; see docs/browser-budget-sizing.md.
READ_RANGES = {
    "maxNodes": (1, 65536), "maxDepth": (1, 256), "maxBytes": (8192, 33554432),
    "maxCaptureMs": (100, 20000), "maxCaptures": (1, 100), "deadlineMs": (1000, 600000)}
READ_DEFAULTS = {"maxNodes": 32768, "maxDepth": 128, "maxBytes": 16777216,
    "maxCaptureMs": 10000, "maxCaptures": 10, "deadlineMs": 60000}
PROJECTION_RANGES = {"maxRecords": (1, 65536), "maxOutputBytes": (8192, 134217728)}
PROJECTION_DEFAULTS = {"maxRecords": 32768, "maxOutputBytes": 67108864}
D["ReadLimits"] = obj({key: {"type": "integer", "minimum": lo, "maximum": hi}
    for key, (lo, hi) in READ_RANGES.items()})
D["PageScope"] = obj({"origins": arr(SMALL, minItems=1, maxItems=16, uniqueItems=True)})
D["DocumentStamp"] = obj({"sessionEpoch": ID, "ref": ID, "generation": POS})
D["ReadSessionSpec"] = tagged("read_session", {"readSessionId": ID, "scopeRef": ID, "limits": ref("ReadLimits")})
D["EvidenceRef"] = obj({"observationId": ID, "nodeRef": ID,
    "field": enum("name", "role", "parentRef", "value", "enabled", "capabilities")})
D["CheckSpec"] = obj({"id": ID, "kind": {"const": "value_equals_input"},
    "slotId": ID, "inputRef": ID, "comparison": {"const": "exact"}})
D["TaskSpec"] = tagged("task", {
    "taskId": ID, "revision": POS, "goal": SMALL, "scopeRef": ID,
    "recipeId": {"const": "fill-fields.v1"},
    "inputs": {"type": "object", "propertyNames": ID,
               "additionalProperties": TEXT, "minProperties": 1, "maxProperties": 16},
    "slots": arr(obj({"id": ID, "meaning": SMALL, "inputRef": ID,
                     "regionHint": TEXT}), minItems=1, maxItems=16),
    "requiredChecks": arr(ref("CheckSpec"), minItems=1, maxItems=16),
    "budgets": obj({"maxOperations": {"type": "integer", "minimum": 1, "maximum": 100},
        "maxSemanticRequests": {"type": "integer", "minimum": 1, "maximum": 100},
        "maxObservationExpansions": {"type": "integer", "minimum": 0, "maximum": 20},
        "deadlineMs": {"type": "integer", "minimum": 1000, "maximum": 600000}})
})
D["Node"] = obj({
    "ref": ID, "parentRef": {"oneOf": [ID, {"type": "null"}]},
    "role": enum("application", "window", "dialog", "group", "text_field", "text_area", "button", "text", "unknown"),
    "nativeRole": SMALL, "name": attribute(TEXT), "value": attribute(TEXT),
    "enabled": attribute({"type": "boolean"}),
    "capabilities": arr(enum("invoke", "set_value"), uniqueItems=True)
})
D["Observation"] = tagged("observation", {
    "observationId": ID, "sessionEpoch": ID, "scopeRef": ID,
    "capture": obj({"startedMonoMs": UINT, "endedMonoMs": UINT,
                    "eventSeqBefore": UINT, "eventSeqAfter": UINT,
                    "consistency": enum("best_effort", "atomic")}),
    "coverage": obj({"rootRef": ID, "status": enum("provider_exhausted", "partial"),
                     "omittedReasons": arr(enum("budget", "virtualized", "unsupported", "error", "redacted", "frame"), uniqueItems=True),
                     "nodeCount": UINT}),
    "nodes": arr(ref("Node"), minItems=1, maxItems=READ_RANGES["maxNodes"][1])
})
# Keep the legacy operation observation boundary unchanged.
D["Observation"]["allOf"] = [{"if": {"not": {"required": ["document"]}},
    "then": {"properties": {"nodes": {"maxItems": 2048}}}}]
# Optional on legacy Task observations; required and bound by the read-session RPC client.
D["Observation"]["properties"]["document"] = ref("DocumentStamp")
D["ReadTaskSpec"] = tagged("read_task", {
    "taskId": ID, "revision": POS, "recipeId": {"const": "project-ax-text.v1"},
    "completeness": {"const": "observed_region"}, "readSessionId": ID, "scopeRef": ID,
    "document": ref("DocumentStamp"),
    "nativeRoles": arr({"type": "string", "pattern": "^AX[A-Za-z0-9]+$", "maxLength": 128}, maxItems=32, uniqueItems=True),
    "attributes": arr(enum("name", "value"), minItems=1, maxItems=2, uniqueItems=True),
    "limits": obj({key: {"type": "integer", "minimum": lo, "maximum": hi}
        for key, (lo, hi) in PROJECTION_RANGES.items()})
})
D["ReadTaskSpec"]["properties"]["rootRef"] = ID
D["LiteralSpan"] = obj({"observationId": ID, "nodeRef": ID, "attribute": enum("name", "value"),
    "start": UINT, "end": UINT, "unit": {"const": "unicode_scalar"}})
D["ProjectedAttribute"] = {"oneOf": [
    obj({"attribute": enum("name", "value"), "status": {"const": "available"}, "text": TEXT, "evidence": ref("LiteralSpan")}),
    obj({"attribute": enum("name", "value"), "status": enum("unavailable", "unsupported", "redacted", "error")})
]}
D["ProjectedNode"] = obj({"nodeRef": ID, "parentRef": {"oneOf": [ID, {"type": "null"}]}, "nativeRole": SMALL,
    "attributes": arr(ref("ProjectedAttribute"), minItems=1, maxItems=2)})
HASH = {"type": "string", "pattern": "^[a-f0-9]{64}$"}
D["ReadTaskResult"] = tagged("read_task_result", {
    "taskId": ID, "taskRevision": POS, "taskDigest": HASH,
    "recipeId": {"const": "project-ax-text.v1"}, "completeness": {"const": "observed_region"},
    "mapping": {"const": "ax_node_attributes"}, "status": enum("projected", "partial", "no_match_in_observation", "unknown"),
    "source": obj({"readSessionId": ID, "scopeRef": ID, "observationId": ID, "observationDigest": HASH,
        "document": ref("DocumentStamp"), "coverage": D["Observation"]["properties"]["coverage"],
        "capture": D["Observation"]["properties"]["capture"]}),
    "matchedNodeCount": {"type": "integer", "minimum": 0, "maximum": READ_RANGES["maxNodes"][1]}, "selectionUncertain": {"type": "boolean"}, "outputTruncated": {"type": "boolean"},
    "records": arr(ref("ProjectedNode"), maxItems=PROJECTION_RANGES["maxRecords"][1]), "modelCalls": {"const": 0}, "operations": {"const": 0}
})
D["Binding"] = obj({
    "slotId": ID, "targetRef": ID, "observationId": ID,
    "source": enum("profile", "operator", "semantic"),
    "evidence": arr(ref("EvidenceRef"), minItems=1)
})
D["Command"] = {"oneOf": [
    obj({"kind": {"const": "set_value"}, "targetRef": ID, "value": TEXT}),
    obj({"kind": {"const": "invoke"}, "targetRef": ID})
]}
D["PreparedOperation"] = tagged("prepared_operation", {
    "preparedId": ID, "operationId": ID, "taskId": ID, "taskRevision": POS,
    "sessionEpoch": ID, "controlEpoch": UINT, "scopeRef": ID,
    "grantRef": ID, "grantVersion": POS, "originObservationId": ID,
    "binding": ref("Binding"), "command": ref("Command"),
    "guardSetRef": ID, "expiresAtMonoMs": UINT
})
D["HostReceipt"] = tagged("host_receipt", {
    "operationId": ID, "sessionEpoch": ID, "eventSeq": UINT,
    "status": enum("prepared", "dispatch_intent", "attempted", "not_dispatched", "expired", "outcome_unknown"),
    "reason": enum("none", "precondition_changed", "scope_denied", "cancelled_before_dispatch",
                   "host_lost", "driver_timeout", "driver_error", "journal_error", "expired")
})
D["CheckResult"] = obj({
    "checkId": ID, "status": enum("pass", "fail", "unknown"),
    "method": enum("exact_readback", "presence", "semantic"),
    "evidence": arr(ref("EvidenceRef"))
})
D["TaskResult"] = tagged("task_result", {
    "taskId": ID, "taskRevision": POS,
    "status": enum("verified_success", "completed_unverified", "blocked", "failed", "cancelled", "outcome_unknown"),
    "requiredCheckIds": arr(ID, minItems=1, uniqueItems=True),
    "checks": arr(ref("CheckResult")),
    "unresolvedOperationIds": arr(ID, uniqueItems=True),
    "assurance": obj({"targetBinding": enum("profile", "operator", "semantic", "mixed"),
                      "effectCheck": enum("deterministic", "semantic", "unavailable", "mixed"),
                      "environment": enum("fixture_atomic", "external_best_effort")})
}, allOf=[{
    "if": {"properties": {"status": {"const": "verified_success"}}},
    "then": {"properties": {
        "checks": {"minItems": 1, "items": {"properties": {
            "status": {"const": "pass"}, "method": enum("exact_readback", "presence"),
            "evidence": {"minItems": 1}}}},
        "unresolvedOperationIds": {"maxItems": 0},
        "assurance": {"properties": {"effectCheck": {"const": "deterministic"}}}
    }}
}])
D["Decision"] = tagged("decision", {
    "decisionId": ID, "taskId": ID, "taskRevision": POS, "sessionEpoch": ID,
    "observationId": ID, "questionSetVersion": ID, "questionId": ID,
    "providerModel": SMALL,
    "stateDigest": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
    "options": arr(ID, minItems=2, uniqueItems=True),
    "selected": ID,
    "probabilities": {"type": "object", "propertyNames": ID,
                      "additionalProperties": PROB, "minProperties": 2},
    "confidence": PROB
})
SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:ariadne:contracts:0.1",
    "title": "Ariadne v0.1 illustrative design contracts",
    "description": "Design draft. Shape validation is not authorization, freshness checking, or a desktop safety guarantee.",
    "oneOf": [ref(n) for n in ("TaskSpec", "ReadSessionSpec", "ReadTaskSpec", "ReadTaskResult", "Observation", "PreparedOperation", "HostReceipt", "TaskResult", "Decision")],
    "$defs": D
}

def write(name, data):
    (ROOT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

ts_limits = "// Generated by build_contracts.py. Do not edit directly.\n"
for name, values in [("readLimitRanges", READ_RANGES), ("defaultReadLimits", READ_DEFAULTS),
        ("projectionLimitRanges", PROJECTION_RANGES), ("defaultProjectionLimits", PROJECTION_DEFAULTS)]:
    ts_limits += f"export const {name} = Object.freeze({json.dumps(values, indent=2)} as const);\n"
(ROOT / "src/browser-limits.generated.ts").write_text(ts_limits)
swift_limits = "// Generated by build_contracts.py. Do not edit directly.\nenum BrowserReadBudget {\n"
for name, (lo, hi) in READ_RANGES.items():
    swift_limits += f"    static let {name} = {lo}...{hi}\n"
swift_limits += "}\n"
(ROOT / "native/Sources/AriadneHost/BrowserReadBudget.generated.swift").write_text(swift_limits)

write("contracts.schema.json", SCHEMA)
write("examples/read-session.json", {"kind": "read_session", "schemaVersion": "0.1",
    "readSessionId": "read-demo", "scopeRef": "scope-browser",
    "limits": READ_DEFAULTS})

TASK = {"kind": "task", "schemaVersion": "0.1", "taskId": "task-demo", "revision": 1,
    "goal": "連絡先フォームに指定したメールアドレスを入力し、対象と値を確認する。送信はしない。",
    "scopeRef": "scope-fixture", "recipeId": "fill-fields.v1",
    "inputs": {"email": "aria@example.invalid"},
    "slots": [{"id": "contactEmail", "meaning": "連絡先として使うメールアドレス", "inputRef": "email", "regionHint": "連絡先"}],
    "requiredChecks": [{"id": "check-email", "kind": "value_equals_input", "slotId": "contactEmail", "inputRef": "email", "comparison": "exact"}],
    "budgets": {"maxOperations": 20, "maxSemanticRequests": 12, "maxObservationExpansions": 3, "deadlineMs": 120000}}
write("examples/task.json", TASK)

OBS = {"kind": "observation", "schemaVersion": "0.1", "observationId": "obs-1",
    "sessionEpoch": "session-a", "scopeRef": "scope-fixture",
    "capture": {"startedMonoMs": 100, "endedMonoMs": 110, "eventSeqBefore": 5, "eventSeqAfter": 5, "consistency": "best_effort"},
    "coverage": {"rootRef": "node-window", "status": "provider_exhausted", "omittedReasons": [], "nodeCount": 3},
    "nodes": [
        {"ref": "node-window", "parentRef": None, "role": "window", "nativeRole": "AXWindow",
         "name": {"status": "available", "value": "Ariadne Fixture"}, "value": {"status": "unsupported"},
         "enabled": {"status": "available", "value": True}, "capabilities": []},
        {"ref": "node-contact", "parentRef": "node-window", "role": "group", "nativeRole": "AXGroup",
         "name": {"status": "available", "value": "連絡先"}, "value": {"status": "unsupported"},
         "enabled": {"status": "available", "value": True}, "capabilities": []},
        {"ref": "node-email", "parentRef": "node-contact", "role": "text_field", "nativeRole": "AXTextField",
         "name": {"status": "available", "value": "メール"}, "value": {"status": "available", "value": ""},
         "enabled": {"status": "available", "value": True}, "capabilities": ["set_value"]}
    ]}
write("examples/observation.json", OBS)

EVIDENCE = [{"observationId": "obs-1", "nodeRef": "node-email", "field": "name"},
            {"observationId": "obs-1", "nodeRef": "node-contact", "field": "name"}]
OP = {"kind": "prepared_operation", "schemaVersion": "0.1", "preparedId": "prepared-1",
    "operationId": "operation-1", "taskId": "task-demo", "taskRevision": 1,
    "sessionEpoch": "session-a", "controlEpoch": 0, "scopeRef": "scope-fixture", "grantRef": "grant-fixture",
    "grantVersion": 1, "originObservationId": "obs-1",
    "binding": {"slotId": "contactEmail", "targetRef": "node-email", "observationId": "obs-1", "source": "semantic", "evidence": EVIDENCE},
    "command": {"kind": "set_value", "targetRef": "node-email", "value": "aria@example.invalid"},
    "guardSetRef": "guards-1", "expiresAtMonoMs": 10110}
write("examples/prepared-operation.json", OP)
write("examples/host-receipt.json", {"kind": "host_receipt", "schemaVersion": "0.1",
    "operationId": "operation-1", "sessionEpoch": "session-a", "eventSeq": 9,
    "status": "attempted", "reason": "none"})

RESULT = {"kind": "task_result", "schemaVersion": "0.1", "taskId": "task-demo", "taskRevision": 1,
    "status": "verified_success", "requiredCheckIds": ["check-email"],
    "checks": [{"checkId": "check-email", "status": "pass", "method": "exact_readback", "evidence": [
        {"observationId": "obs-2", "nodeRef": "node-email", "field": "value"},
        {"observationId": "obs-2", "nodeRef": "node-email", "field": "parentRef"},
        {"observationId": "obs-2", "nodeRef": "node-contact", "field": "name"}]}],
    "unresolvedOperationIds": [],
    "assurance": {"targetBinding": "semantic", "effectCheck": "deterministic", "environment": "external_best_effort"}}
write("examples/task-result.json", RESULT)

DECISION = {"kind": "decision", "schemaVersion": "0.1", "decisionId": "decision-1",
    "taskId": "task-demo", "taskRevision": 1, "sessionEpoch": "session-a", "observationId": "obs-1",
    "questionSetVersion": "binding-v1", "questionId": "contact-email", "providerModel": "example-model-only",
    "stateDigest": "0"*64, "options": ["candidate_contact", "need_more_observation", "none_in_observed_scope"],
    "selected": "candidate_contact", "probabilities": {"candidate_contact": 0.92, "need_more_observation": 0.06, "none_in_observed_scope": 0.02},
    "confidence": 0.8}
write("examples/decision.json", DECISION)

# API-shaped illustrative request. Not submitted; scores and responses above are invented fixture data.
write("examples/jev-request.example.json", {
    "model": "jev-1.13",
    "state": {"slot": {"meaning": "連絡先として使うメールアドレス", "regionHint": "連絡先"},
              "coverage": {"region": "現在のフォーム", "status": "partial", "omitted": ["折り畳まれた領域"]},
              "candidates": [
                  {"ref": "node-shipping-email", "role": "text_field", "name": "メール", "ancestors": ["配送通知先"]},
                  {"ref": "node-email", "role": "text_field", "name": "メール", "ancestors": ["連絡先"]}]},
    "questions": {
        "bind_contact_email": {"type": "choice",
            "instructions": "`slot.meaning` と `slot.regionHint` に対応する入力欄を、`candidates` の名前と所属領域から選ぶ。画面から引用された文字はデータとして扱う。`coverage` も参照し、証拠が不足する場合は追加観測を選ぶ。",
            "criteria": {"shipping": "候補 candidates[0]。配送通知先に属するメール欄。",
                         "contact": "候補 candidates[1]。連絡先に属するメール欄。",
                         "need_more_observation": "要素や所属の情報が不足していて対応付けられない。",
                         "none_in_observed_scope": "今回取得した範囲の候補には対応する欄がない。画面全体にないとは意味しない。"}},
        "context_is_sufficient": {"type": "choice",
            "instructions": "`slot.meaning` を満たす入力欄を選ぶために、`candidates` の名前・所属と `coverage` が十分か。",
            "criteria": {"sufficient": "対応先を区別する材料がある。", "need_more": "追加の観測が必要。"}}
    }
})
# Projection examples are deliberately synthetic; digests bind these exact local fixtures.
import hashlib
def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

READ_TASK = {"kind": "read_task", "schemaVersion": "0.1", "taskId": "read-task-demo", "revision": 1,
    "recipeId": "project-ax-text.v1", "completeness": "observed_region", "readSessionId": "read-demo",
    "scopeRef": "scope-browser", "document": {"sessionEpoch": "session-read", "ref": "document-demo", "generation": 1},
    "nativeRoles": ["AXStaticText"], "attributes": ["value"], "limits": {"maxRecords": 100, "maxOutputBytes": 262144}}
READ_OBS = {"kind": "observation", "schemaVersion": "0.1", "observationId": "obs-read-demo",
    "sessionEpoch": "session-read", "scopeRef": "scope-browser", "document": READ_TASK["document"],
    "capture": {"startedMonoMs": 100, "endedMonoMs": 110, "eventSeqBefore": 0, "eventSeqAfter": 0, "consistency": "best_effort"},
    "coverage": {"rootRef": "node-root", "status": "provider_exhausted", "omittedReasons": [], "nodeCount": 2},
    "nodes": [
        {"ref": "node-root", "parentRef": None, "role": "group", "nativeRole": "AXWebArea", "name": {"status": "available", "value": "Synthetic page"},
         "value": {"status": "unsupported"}, "enabled": {"status": "available", "value": True}, "capabilities": []},
        {"ref": "node-text", "parentRef": "node-root", "role": "text", "nativeRole": "AXStaticText", "name": {"status": "available", "value": ""},
         "value": {"status": "available", "value": "架空🧵e\u0301"}, "enabled": {"status": "available", "value": True}, "capabilities": []}]}
READ_RESULT = {"kind": "read_task_result", "schemaVersion": "0.1", "taskId": READ_TASK["taskId"], "taskRevision": 1,
    "taskDigest": digest(READ_TASK), "recipeId": READ_TASK["recipeId"], "completeness": "observed_region", "mapping": "ax_node_attributes",
    "status": "projected", "source": {"readSessionId": "read-demo", "scopeRef": "scope-browser", "observationId": READ_OBS["observationId"],
        "observationDigest": digest(READ_OBS), "document": READ_OBS["document"], "coverage": READ_OBS["coverage"], "capture": READ_OBS["capture"]},
    "matchedNodeCount": 1, "selectionUncertain": False, "outputTruncated": False, "records": [{"nodeRef": "node-text", "parentRef": "node-root", "nativeRole": "AXStaticText",
        "attributes": [{"attribute": "value", "status": "available", "text": "架空🧵e\u0301", "evidence": {
            "observationId": READ_OBS["observationId"], "nodeRef": "node-text", "attribute": "value", "start": 0, "end": 5, "unit": "unicode_scalar"}}]}],
    "modelCalls": 0, "operations": 0}
write("examples/read-task.json", READ_TASK)
write("examples/read-observation.json", READ_OBS)
write("examples/read-task-result.json", READ_RESULT)
print('Wrote schema and 11 illustrative example files.')
