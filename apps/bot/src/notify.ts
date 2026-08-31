export type Notification = { discordId: string; channelId: string; content: string };
export type Sender = (n: Notification) => Promise<void>;

// Retrying forever is correct — the binding is real, and the message should
// land the moment it can — but logging every tick forever for a player who
// will never be reachable is not. Log each challenge's failure once per
// notifier rather than on every retry.
//
// ⚠️ Owned by the caller, not this module. Module-level state would be shared
// by every bot instance in the process AND by every test file in one module
// registry — and since challenge ids restart at 1 after a truncate, one
// suite's logged id silently suppresses another's expected log.
export type NotifyFailureLog = Set<number>;
export const createNotifyFailureLog = (): NotifyFailureLog => new Set<number>();
