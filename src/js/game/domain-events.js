import { growOfficer, playerOfficer } from "./character-state.js";

/** Commit-only events. Call on a transaction draft, never on a preview or from rendering.
 * Receipt IDs are persisted: resume/reload cannot award the same completion twice. */
export function emitDomainEvent(state, event) {
  if (!event.id || !event.type) throw new TypeError("Event requires stable id and type");
  state.domainEvents ??= { sequence: 0, receipts: [], recent: [] };
  if (state.domainEvents.receipts.includes(event.id)) return false;
  const envelope = { ...structuredClone(event), sequence: ++state.domainEvents.sequence, turn: state.elapsedMonths ?? 0 };
  state.domainEvents.receipts.push(event.id);
  state.domainEvents.recent = [envelope, ...state.domainEvents.recent].slice(0, 100);
  const officer = playerOfficer(state);
  if (officer && event.officerIds?.includes(officer.id)) {
    if (event.type === "task.completed") {
      growOfficer(officer, event.ability ?? "politics", 35);
      state.personal.journal.unshift(`完成${event.title}，${event.ability === "leadership" ? "统帅" : "内政"}历练 +35。`);
    }
    if (event.type === "battle.completed") {
      growOfficer(officer, "leadership", 50); growOfficer(officer, "war", 25);
      officer.merit = (officer.merit ?? 0) + 80;
      state.personal.journal.unshift(`参战归来：统帅历练 +50，武力历练 +25，功勋 +80。`);
    }
    state.personal.journal = state.personal.journal.slice(0, 60);
  }
  return true;
}
