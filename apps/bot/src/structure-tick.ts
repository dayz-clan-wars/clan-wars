import type { StructureStore } from "./structure-store.js";
import type { GuildGateway, NicknameOutcome } from "./guild.js";
import { roleNameFor, textChannelNameFor, voiceChannelNameFor } from "./guild.js";

export type StructureTickResult = {
  created: number;
  tornDown: number;
  renamed: number;
  roleAdds: number;
  roleRemoves: number;
  linkedAdds: number;
  linkedRemoves: number;
  nicknamesCleared: number;
  errors: number;
};

export type StructureTickOpts = {
  linkedRoleId: string;
  onError?: (what: string, err: unknown) => void;
  /** Users whose nickname the bot cannot change (owner, outranked, no permission): logged once per instance, never retried. Owned by the caller. */
  nicknameNoRetry?: Set<string>;
};

const NO_RETRY: ReadonlySet<NicknameOutcome> = new Set(["is-owner", "outranked", "no-permission"]);

/**
 * The reconciler: diffs `store` against `guild` and issues only the writes
 * that close a difference. Never throws — every item runs inside `step`,
 * which counts a throw as one error, reports it via `onError`, and moves on
 * to the next item.
 */
export async function structureTick(
  store: StructureStore,
  guild: GuildGateway,
  opts: StructureTickOpts,
): Promise<StructureTickResult> {
  const out: StructureTickResult = {
    created: 0,
    tornDown: 0,
    renamed: 0,
    roleAdds: 0,
    roleRemoves: 0,
    linkedAdds: 0,
    linkedRemoves: 0,
    nicknamesCleared: 0,
    errors: 0,
  };

  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      out.errors++;
      opts.onError?.(what, err);
    }
  };

  // 1. Create — column right after each create, so a crash in between resumes at the next missing column.
  for (const row of await store.clansNeedingStructure()) {
    await step(`create:${row.id}`, async () => {
      let roleId = row.roleId;
      if (roleId === null) {
        roleId = await guild.createRole(roleNameFor(row));
        await store.setRoleId(row.id, roleId);
      }
      let textChannelId = row.textChannelId;
      if (textChannelId === null) {
        textChannelId = await guild.createTextChannel(textChannelNameFor(row), roleId);
        await store.setTextChannelId(row.id, textChannelId);
      }
      let voiceChannelId = row.voiceChannelId;
      if (voiceChannelId === null) {
        voiceChannelId = await guild.createVoiceChannel(voiceChannelNameFor(row), roleId);
        await store.setVoiceChannelId(row.id, voiceChannelId);
      }
      out.created++;
    });
  }

  // 2. Tear down — channels before the role, so a crash mid-way never leaves a channel nobody can see.
  for (const row of await store.clansToTearDown()) {
    await step(`teardown:${row.id}`, async () => {
      if (row.textChannelId !== null) {
        await guild.deleteChannel(row.textChannelId);
        await store.setTextChannelId(row.id, null);
      }
      if (row.voiceChannelId !== null) {
        await guild.deleteChannel(row.voiceChannelId);
        await store.setVoiceChannelId(row.id, null);
      }
      if (row.roleId !== null) {
        await guild.deleteRole(row.roleId);
        await store.setRoleId(row.id, null);
      }
      out.tornDown++;
    });
  }

  // 3. Rename drift — null = deleted by hand: log once, do not recreate.
  for (const row of await store.clansWithStructure()) {
    await step(`rename:${row.id}`, async () => {
      let renamedAny = false;

      const roleName = guild.roleName(row.roleId!);
      if (roleName === null) {
        opts.onError?.(`missing:${row.roleId}`, new Error("role deleted by hand"));
      } else if (roleName !== roleNameFor(row)) {
        await guild.renameRole(row.roleId!, roleNameFor(row));
        renamedAny = true;
      }

      const textName = guild.channelName(row.textChannelId!);
      if (textName === null) {
        opts.onError?.(`missing:${row.textChannelId}`, new Error("channel deleted by hand"));
      } else if (textName !== textChannelNameFor(row)) {
        await guild.renameChannel(row.textChannelId!, textChannelNameFor(row));
        renamedAny = true;
      }

      const voiceName = guild.channelName(row.voiceChannelId!);
      if (voiceName === null) {
        opts.onError?.(`missing:${row.voiceChannelId}`, new Error("channel deleted by hand"));
      } else if (voiceName !== voiceChannelNameFor(row)) {
        await guild.renameChannel(row.voiceChannelId!, voiceChannelNameFor(row));
        renamedAny = true;
      }

      if (renamedAny) out.renamed++;
    });
  }

  // 4. Clan roles — a clan with structure but no full members left in the DB (the store's
  // inner join omits it) must still have its stale role holders removed, hence `?? []`.
  const fullMembersByClan = await store.fullMembersByClan();
  for (const row of await store.clansWithStructure()) {
    await step(`roles:${row.id}`, async () => {
      const roleId = row.roleId!;
      const members = fullMembersByClan.get(row.id) ?? [];
      const desired = new Set(members.filter((id) => guild.isMember(id)));
      const actual = guild.roleMembers(roleId);
      for (const id of desired) {
        if (!actual.has(id)) {
          await guild.addRole(id, roleId);
          out.roleAdds++;
        }
      }
      for (const id of actual) {
        if (!desired.has(id)) {
          await guild.removeRole(id, roleId);
          out.roleRemoves++;
        }
      }
    });
  }

  // 5. @Linked — for each user leaving the link set, clear the nickname THEN remove the
  // role (the link is gone; the role must go regardless of how the nickname clear went).
  const linkedIds = await store.linkedDiscordIds();
  const desiredLinked = new Set([...linkedIds].filter((id) => guild.isMember(id)));
  const actualLinked = guild.roleMembers(opts.linkedRoleId);

  for (const id of actualLinked) {
    if (desiredLinked.has(id)) continue;
    await step(`linked-remove:${id}`, async () => {
      if (!opts.nicknameNoRetry?.has(id)) {
        const outcome = await guild.setNickname(id, null);
        if (NO_RETRY.has(outcome)) {
          opts.nicknameNoRetry?.add(id);
          opts.onError?.(`nickname:${id}`, new Error(`setNickname refused: ${outcome}`));
        } else if (outcome === "ok") {
          out.nicknamesCleared++;
        }
      }
      await guild.removeRole(id, opts.linkedRoleId);
      out.linkedRemoves++;
    });
  }

  for (const id of desiredLinked) {
    if (actualLinked.has(id)) continue;
    await step(`linked-add:${id}`, async () => {
      await guild.addRole(id, opts.linkedRoleId);
      out.linkedAdds++;
    });
  }

  return out;
}
