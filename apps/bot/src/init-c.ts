/** One player's clan armband, ready to be emitted into the init.c lookup. */
export type ArmbandAssignment = { dayzId: string; armband: string };

/**
 * The mission script, with one `{{ARMBAND_TABLE}}` hole.
 *
 * ⚠️ Everything outside that hole is hand-written and VERIFIED ONCE against the
 * running server. Nothing here is derived from data, so the only thing that can
 * vary between renders is a block of validated hex string literals — which is
 * what makes an unattended writer acceptable on a file whose syntax error stops
 * the mission loading.
 *
 * ⚠️ `main()` and everything in CustomMission below OnClientNewEvent is the
 * server's original init.c, reproduced verbatim (downloaded 2026-09-12). The bot
 * owns this file now, so it has to keep doing everything the file used to do —
 * including StartingEquipSetup, which is dead while a spawn preset is configured
 * but is still the fallback if that preset ever fails to load.
 */
const TEMPLATE = `void main()
{
	//INIT ECONOMY--------------------------------------
	Hive ce = CreateHive();
	if ( ce )
		ce.InitOffline();

	//DATE RESET AFTER ECONOMY INIT-------------------------
	int year, month, day, hour, minute;
	int reset_month = 7, reset_day = 17;
	GetGame().GetWorld().GetDate(year, month, day, hour, minute);

	if ((month == reset_month) && (day < reset_day))
	{
		GetGame().GetWorld().SetDate(year, reset_month, reset_day, hour, minute);
	}
	else
	{
		if ((month == reset_month + 1) && (day > reset_day))
		{
			GetGame().GetWorld().SetDate(year, reset_month, reset_day, hour, minute);
		}
		else
		{
			if ((month < reset_month) || (month > reset_month + 1))
			{
				GetGame().GetWorld().SetDate(year, reset_month, reset_day, hour, minute);
			}
		}
	}
}

class CustomMission: MissionServer
{
	// ==== CLAN WARS ARMBANDS - GENERATED, DO NOT EDIT BY HAND ====
	// Written by the bot's restart tick before each scheduled restart.
	string CW_ArmbandFor(string uid)
	{
{{ARMBAND_TABLE}}
		return "";
	}
	// ==== END GENERATED ====

	/**
	 * The one place an armband is attached. Called from all three spawn paths
	 * below, because DayZ splits them across three different events and hooking
	 * only one covers only one of the three ways a character reaches the world.
	 *
	 * Fills an EMPTY slot only: a player wearing a captured enemy band has made
	 * a choice, and overwriting it would turn a spawn gift into enforcement.
	 *
	 * Every branch prints. A silent no-op here is indistinguishable from the
	 * hook never running, which is exactly the hole that cost a deploy on
	 * 2026-09-13 - the file compiled, equipped nothing, and said nothing.
	 */
	void CW_GiveArmband(PlayerIdentity identity, PlayerBase player)
	{
		if ( !player || !identity )
		{
			Print("[CLANWARS] spawn with no player or no identity, skipping");
			return;
		}

		string uid = identity.GetId();
		string band = CW_ArmbandFor(uid);
		if ( band == "" )
		{
			Print("[CLANWARS] uid=" + uid + " not in any clan, no armband");
			return;
		}

		if ( player.FindAttachmentBySlotName("Armband") )
		{
			Print("[CLANWARS] uid=" + uid + " already wearing an armband, leaving it");
			return;
		}

		EntityAI band_ent = player.GetInventory().CreateAttachment(band);
		if ( band_ent )
		{
			Print("[CLANWARS] uid=" + uid + " attached " + band);
		}
		else
		{
			Print("[CLANWARS] uid=" + uid + " FAILED to attach " + band);
		}
	}

	/**
	 * A character created ON CONNECT. Not StartingEquipSetup and not
	 * EquipCharacter: with a spawn preset configured, vanilla OnClientNewEvent
	 * returns right after ProcessEquipmentData and never reaches either, so a
	 * hook there equips nothing and reports success.
	 */
	override PlayerBase OnClientNewEvent(PlayerIdentity identity, vector pos, ParamsReadContext ctx)
	{
		PlayerBase player = super.OnClientNewEvent(identity, pos, ctx);
		Print("[CLANWARS] OnClientNewEvent");
		CW_GiveArmband(identity, player);
		return player;
	}

	/**
	 * A new character AFTER DEATH. This is the event a respawn actually fires,
	 * and hooking OnClientNewEvent alone missed it entirely: a suicide produced
	 * a fresh character with no armband, no error, and no trace.
	 */
	override void OnClientRespawnEvent(PlayerIdentity identity, PlayerBase player)
	{
		super.OnClientRespawnEvent(identity, player);
		Print("[CLANWARS] OnClientRespawnEvent");
		CW_GiveArmband(identity, player);
	}

	/**
	 * An EXISTING saved character loaded on connect - MissionServer's equivalent
	 * of PlayerBase.OnStoreLoad, which cannot be hooked from here (it would need
	 * a modded PlayerBase class, and console DayZ allows no mods). This is what
	 * gives a band to someone who joined a clan while alive: they reconnect.
	 */
	override void OnClientReadyEvent(PlayerIdentity identity, PlayerBase player)
	{
		super.OnClientReadyEvent(identity, player);
		Print("[CLANWARS] OnClientReadyEvent");
		CW_GiveArmband(identity, player);
	}

	void SetRandomHealth(EntityAI itemEnt)
	{
		if ( itemEnt )
		{
			float rndHlt = Math.RandomFloat( 0.45, 0.65 );
			itemEnt.SetHealth01( "", "", rndHlt );
		}
	}

	override PlayerBase CreateCharacter(PlayerIdentity identity, vector pos, ParamsReadContext ctx, string characterName)
	{
		Entity playerEnt;
		playerEnt = GetGame().CreatePlayer( identity, characterName, pos, 0, "NONE" );
		Class.CastTo( m_player, playerEnt );

		GetGame().SelectPlayer( identity, m_player );

		return m_player;
	}

	override void StartingEquipSetup(PlayerBase player, bool clothesChosen)
	{
		EntityAI itemClothing;
		EntityAI itemEnt;
		ItemBase itemBs;
		float rand;

		itemClothing = player.FindAttachmentBySlotName( "Body" );
		if ( itemClothing )
		{
			SetRandomHealth( itemClothing );

			itemEnt = itemClothing.GetInventory().CreateInInventory( "BandageDressing" );
			player.SetQuickBarEntityShortcut(itemEnt, 2);

			string chemlightArray[] = { "Chemlight_White", "Chemlight_Yellow", "Chemlight_Green", "Chemlight_Red" };
			int rndIndex = Math.RandomInt( 0, 4 );
			itemEnt = itemClothing.GetInventory().CreateInInventory( chemlightArray[rndIndex] );
			player.SetQuickBarEntityShortcut(itemEnt, 1);
			SetRandomHealth( itemEnt );
		}

		itemClothing = player.FindAttachmentBySlotName( "Legs" );
		if ( itemClothing )
			SetRandomHealth( itemClothing );

		itemClothing = player.FindAttachmentBySlotName( "Feet" );
	}
};

Mission CreateCustomMission(string path)
{
	return new CustomMission();
}
`;

/** The ADM/script-log id shape, and the only shape allowed into a string literal. */
const UID_RE = /^[0-9A-F]{40}$/u;
/** `armbandFor()` only ever yields `Armband_<flag>`; anything else is not ours to emit. */
const ARMBAND_RE = /^Armband_[A-Za-z0-9_]+$/u;

export function renderInitC(assignments: ArmbandAssignment[]): string {
  const table = assignments
    .filter((a) => {
      // ⚠️ Drop, never emit. A row that fails here is a row we cannot prove is
      // safe to paste into script — one stray quote closes the literal and the
      // mission stops loading. Skipping costs one player an armband; emitting
      // costs everyone the server.
      if (!UID_RE.test(a.dayzId)) {
        console.warn(`init.c: skipping assignment with malformed dayz id: ${JSON.stringify(a.dayzId)}`);
        return false;
      }
      if (!ARMBAND_RE.test(a.armband)) {
        console.warn(`init.c: skipping ${a.dayzId} — not an armband classname: ${JSON.stringify(a.armband)}`);
        return false;
      }
      return true;
    })
    .sort((x, y) => (x.dayzId < y.dayzId ? -1 : x.dayzId > y.dayzId ? 1 : 0))
    .map((a) => `\t\tif (uid == "${a.dayzId}") return "${a.armband}";`)
    .join("\n");
  // ⚠️ CRLF to match the mission tree. Normalised at the end rather than written
  // into the template, so the template stays readable and no arm can slip
  // through with a bare LF.
  return TEMPLATE.replace("{{ARMBAND_TABLE}}", table).replace(/\r?\n/gu, "\r\n");
}
