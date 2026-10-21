class CfgPatches {
    class DZ_Weapons_Firearms_M4 {
        units[] = {"M4A1"};
        requiredAddons[] = {"DZ_Data"};
    };
};
class Mode_SemiAuto;
class cfgWeapons {
    class Rifle_Base;
    class M4A1_Base: Rifle_Base {
        scope = 0;
        weight = 2276;
        itemSize[] = {9, 3};
        chamberableFrom[] = {"Ammo_556x45", "Ammo_556x45Tracer"};
        magazines[] = {
            "Mag_STANAG_30Rnd",
            "Mag_CMAG_30Rnd",
            "Mag_Drum_TEST"
        };
        attachments[] = {"weaponButtstockM4", "WeaponHandguardM4", "weaponOptics"};
        class SemiAuto: Mode_SemiAuto {
            soundSetShotExt[] = {{"a", "b"}, {"c"}};
            reloadTime = 0.12;
        };
    };
    class M4A1: M4A1_Base {
        scope = 2;
        displayName = "$STR_cfgWeapons_M4A10";
        descriptionShort = "$STR_cfgWeapons_M4A11";
        attachments[] += {"weaponFlashlight"};
    };
    class M4A1_Green: M4A1 {
        hiddenSelectionsTextures[] = {"dz\weapons\firearms\m4\data\m4_green_co.paa"};
    };
};
class CfgMagazines {
    class Magazine_Base;
    class Mag_STANAG_30Rnd: Magazine_Base {
        scope = 2;
        displayName = "$STR_CfgMagazines_Mag_STANAG_30Rnd0";
        descriptionShort = "Plain text, not a key.";
        weight = 120;
        itemSize[] = {1, 3};
        ammoItems[] = {"Ammo_556x45", "Ammo_556x45Tracer"};
        inventorySlot[] = {"magazine"};
    };
    class Mag_CMAG_30Rnd: Mag_STANAG_30Rnd {
        displayName = "";
    };
    class Ammo_556x45: Magazine_Base {
        scope = 2;
        weight = 12;
        itemSize[] = {1, 1};
    };
    class Ammo_556x45Tracer: Ammo_556x45 {};
};
class CfgVehicles {
    class Inventory_Base;
    class M4_OEBttstck: Inventory_Base {
        scope = 2;
        displayName = "$STR_cfgVehicles_M4_OEBttstck0";
        inventorySlot = "weaponButtstockM4";
    };
    class M4_MPHndgrd: Inventory_Base {
        scope = 2;
        inventorySlot[] = {"weaponHandguardM4"};
    };
    class ACOGOptic: Inventory_Base {
        scope = 2;
        inventorySlot[] = {"weaponOptics", "weaponOpticsAug"};
    };
    class Flashlight_Base: Inventory_Base {
        inventorySlot[] = {"weaponFlashlight", "helmetFlashlight"};
    };
    class UniversalLight: Flashlight_Base {
        scope = 2;
    };
};
