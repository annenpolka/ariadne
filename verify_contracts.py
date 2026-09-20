#!/usr/bin/env python3
"""Validate the Ariadne design draft's examples and mutation tests.

Dependency: jsonschema (Draft 2020-12 support).
This tests data contracts and selected cross-field rules only. It does not
implement or verify the desktop runtime, permission broker, or provider.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

ROOT = Path(__file__).resolve().parent
SCHEMA = json.loads((ROOT / "contracts.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(SCHEMA)
VALIDATOR = Draft202012Validator(SCHEMA)


def require(test: bool, message: str) -> None:
    if not test:
        raise ValueError(message)


def cross_field_checks(data: dict[str, Any]) -> None:
    """Small, explicit rules JSON Schema alone does not express here."""
    kind = data["kind"]
    if kind == "task":
        slots = data["slots"]
        slot_map = {s["id"]: s for s in slots}
        require(len(slot_map) == len(slots), "duplicate slot ids")
        for slot in slots:
            require(slot["inputRef"] in data["inputs"], "unknown inputRef")
        checks = data["requiredChecks"]
        require(len({c["id"] for c in checks}) == len(checks), "duplicate check ids")
        require(len(checks) == len(slots), "fill-fields.v1 needs one required check per slot")
        require({c["slotId"] for c in checks} == set(slot_map), "unchecked or unknown slot")
        for check in checks:
            require(check["inputRef"] == slot_map[check["slotId"]]["inputRef"], "check must read the assigned input")
    elif kind == "observation":
        if "document" in data:
            require(data["document"]["sessionEpoch"] == data["sessionEpoch"], "document epoch mismatch")
            require(all(not node["capabilities"] for node in data["nodes"]), "read observation exposes capabilities")
            for node in data["nodes"]:
                for key in ("name", "value", "enabled"):
                    status = node[key]["status"]
                    if status in ("error", "redacted"):
                        require(data["coverage"]["status"] == "partial" and status in data["coverage"]["omittedReasons"], "read observation hides omitted attributes")
        c = data["capture"]
        require(c["endedMonoMs"] >= c["startedMonoMs"], "capture time reversed")
        require(c["eventSeqAfter"] >= c["eventSeqBefore"], "event sequence reversed")
        nodes = data["nodes"]
        refs = {n["ref"] for n in nodes}
        require(len(refs) == len(nodes), "duplicate node refs")
        require(data["coverage"]["rootRef"] in refs, "coverage root absent")
        require(data["coverage"]["nodeCount"] == len(nodes), "nodeCount mismatch")
        if data["coverage"]["status"] == "provider_exhausted":
            require(not data["coverage"]["omittedReasons"], "exhausted capture cannot declare omissions")
        else:
            require(bool(data["coverage"]["omittedReasons"]), "partial capture needs a reason")
    elif kind == "prepared_operation":
        require(data["command"]["targetRef"] == data["binding"]["targetRef"], "target changed after binding")
        require(data["originObservationId"] == data["binding"]["observationId"], "binding observation mismatch")
        for evidence in data["binding"]["evidence"]:
            require(evidence["observationId"] == data["originObservationId"], "binding evidence comes from a different observation")
    elif kind == "decision":
        p = data["probabilities"]
        require(set(p) == set(data["options"]), "probability keys differ from options")
        require(data["selected"] in p, "selected option absent")
        require(all(math.isfinite(v) for v in p.values()), "nonfinite probability")
        require(math.isfinite(data["confidence"]), "nonfinite confidence")
        require(math.isclose(sum(p.values()), 1.0, rel_tol=0.0, abs_tol=1e-6), "probabilities do not sum to one")
        require(p[data["selected"]] >= max(p.values()) - 1e-9, "selected option is not a maximum")
    elif kind == "task_result":
        checks = {c["checkId"]: c for c in data["checks"]}
        require(len(checks) == len(data["checks"]), "duplicate result check ids")
        if data["status"] == "verified_success":
            require(set(data["requiredCheckIds"]) == set(checks), "required checks missing or changed")
    elif kind == "read_task_result":
        records = data["records"]
        require(len({r["nodeRef"] for r in records}) == len(records), "duplicate projected nodes")
        require(len(records) <= data["matchedNodeCount"], "projected count exceeds matches")
        require(data["outputTruncated"] == (len(records) < data["matchedNodeCount"]), "projection truncation inconsistent")
        coverage = data["source"]["coverage"]
        require((coverage["status"] == "partial") == bool(coverage["omittedReasons"]), "projection coverage inconsistent")
        partial = coverage["status"] == "partial" or data["selectionUncertain"]
        expected = ("partial" if partial or data["outputTruncated"] else "projected") if data["matchedNodeCount"] else ("unknown" if partial else "no_match_in_observation")
        require(data["status"] == expected, "projection status inconsistent")
        for record in records:
            attrs = record["attributes"]
            require(len({a["attribute"] for a in attrs}) == len(attrs), "duplicate projected attributes")
            for attr in attrs:
                if attr["status"] == "available":
                    require(all(not 0xD800 <= ord(c) <= 0xDFFF for c in attr["text"]), "ill-formed projected Unicode")
                    evidence = attr["evidence"]
                    require(evidence["observationId"] == data["source"]["observationId"] and evidence["nodeRef"] == record["nodeRef"] and evidence["attribute"] == attr["attribute"], "projection evidence mismatch")
                    require(evidence["start"] == 0 and evidence["end"] == len(attr["text"]), "projection must quote full attribute")


def validate(data: dict[str, Any]) -> None:
    VALIDATOR.validate(data)
    cross_field_checks(data)


def load(name: str) -> dict[str, Any]:
    return json.loads((ROOT / "examples" / name).read_text(encoding="utf-8"))


def changed(name: str, mutate) -> dict[str, Any]:
    value = copy.deepcopy(load(name))
    mutate(value)
    return value


def main() -> None:
    cases: list[dict[str, str]] = []
    examples = sorted(p for p in (ROOT / "examples").glob("*.json")
                      if p.name != "jev-request.example.json")
    for path in examples:
        validate(json.loads(path.read_text(encoding="utf-8")))
        cases.append({"test": path.name, "expected": "accept", "actual": "accept"})

    bad = [
        ("read observation cannot hide redaction", changed("read-observation.json", lambda x: x["nodes"][1].update(value={"status": "redacted"}))),
        ("projection cannot claim all records", changed("read-task.json", lambda x: x.update(completeness="all_records"))),
        ("projection cannot add a semantic matcher", changed("read-task.json", lambda x: x.update(label="Email"))),
        ("projection cannot filter missing roles as AX vocabulary", changed("read-task.json", lambda x: x.update(nativeRoles=["unknown"]))),
        ("projection rejects duplicate attributes", changed("read-task.json", lambda x: x.update(attributes=["name", "name"]))),
        ("projection record limit is bounded", changed("read-task.json", lambda x: x["limits"].update(maxRecords=65537))),
        ("projection cannot call model", changed("read-task-result.json", lambda x: x.update(modelCalls=1))),
        ("projection cannot dispatch operations", changed("read-task-result.json", lambda x: x.update(operations=1))),
        ("projection cannot promote partial source", changed("read-task-result.json", lambda x: x["source"]["coverage"].update(status="partial", omittedReasons=["frame"]))),
        ("projection cannot quote a different node", changed("read-task-result.json", lambda x: x["records"][0]["attributes"][0]["evidence"].update(nodeRef="other"))),
        ("projection spans use Unicode scalars", changed("read-task-result.json", lambda x: x["records"][0]["attributes"][0]["evidence"].update(end=6))),
        ("projection cannot replace literal with redacted", changed("read-task-result.json", lambda x: x["records"][0]["attributes"][0].update(status="redacted"))),
        ("read session cannot carry Task slots", changed("read-session.json", lambda x: x.update(slots=[]))),
        ("read node budget too large", changed("read-session.json", lambda x: x["limits"].update(maxNodes=65537))),
        ("read budget cannot be fractional", changed("read-session.json", lambda x: x["limits"].update(maxCaptureMs=100.5))),
        ("read byte budget too small", changed("read-session.json", lambda x: x["limits"].update(maxBytes=8191))),
        ("unknown task field", changed("task.json", lambda x: x.update(allowAllApps=True))),
        ("zero task revision", changed("task.json", lambda x: x.update(revision=0))),
        ("missing required checks", changed("task.json", lambda x: x.update(requiredChecks=[]))),
        ("dangling input reference", changed("task.json", lambda x: x["slots"][0].update(inputRef="missing"))),
        ("duplicate slots", changed("task.json", lambda x: x["slots"].append(copy.deepcopy(x["slots"][0])))),
        ("coordinate override", changed("prepared-operation.json", lambda x: x["command"].update(at=[100, 200]))),
        ("bound target substitution", changed("prepared-operation.json", lambda x: x["command"].update(targetRef="node-other"))),
        ("operation missing text", changed("prepared-operation.json", lambda x: x["command"].pop("value"))),
        ("wrong binding observation", changed("prepared-operation.json", lambda x: x["binding"].update(observationId="obs-old"))),
        ("negative probability", changed("decision.json", lambda x: x["probabilities"].update(candidate_contact=-0.1))),
        ("confidence above one", changed("decision.json", lambda x: x.update(confidence=2))),
        ("unlisted selected option", changed("decision.json", lambda x: x.update(selected="invented"))),
        ("incomplete distribution", changed("decision.json", lambda x: x["probabilities"].pop("need_more_observation"))),
        ("unnormalized distribution", changed("decision.json", lambda x: x["probabilities"].update(candidate_contact=0.7))),
        ("verified unknown check", changed("task-result.json", lambda x: x["checks"][0].update(status="unknown"))),
        ("verified semantic-only check", changed("task-result.json", lambda x: x["checks"][0].update(method="semantic"))),
        ("verified without evidence", changed("task-result.json", lambda x: x["checks"][0].update(evidence=[]))),
        ("verified unresolved operation", changed("task-result.json", lambda x: x.update(unresolvedOperationIds=["operation-1"]))),
        ("verified missing required check", changed("task-result.json", lambda x: x["requiredCheckIds"].append("check-not-run"))),
        ("capture time reversed", changed("observation.json", lambda x: x["capture"].update(endedMonoMs=99))),
        ("unavailable is not empty", changed("observation.json", lambda x: x["nodes"][0]["value"].update(value=""))),
        ("incorrect node count", changed("observation.json", lambda x: x["coverage"].update(nodeCount=99))),
    ]
    for name, item in bad:
        try:
            validate(item)
        except (ValueError, ValidationError) as error:
            # The exception name is recorded; no native API, network, or permission checks occur.
            cases.append({"test": name, "expected": "reject", "actual": "reject", "exception": type(error).__name__})
        else:
            raise AssertionError(f"Invalid fixture was accepted: {name}")

    report = {"schema": "Ariadne v0.1 design draft",
              "scope": "JSON shape checks and selected cross-field checks only; synthetic examples",
              "accepted_valid_examples": len(examples), "rejected_mutations": len(bad),
              "native_desktop_tested": False, "live_model_tested": False,
              "runtime_state_machine_tested": False, "cases": cases}
    (ROOT / "validation-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "cases"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
