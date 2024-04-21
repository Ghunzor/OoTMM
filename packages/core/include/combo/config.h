#ifndef COMBO_CONFIG_H
#define COMBO_CONFIG_H

#include <combo/generated_config.h>
#include <combo/prices.h>
#include <combo/types.h>

typedef struct
{
    u8 region;
    u8 world;
}
ItemHint;

typedef struct
{
    ItemHint dungeonRewards[13];
    ItemHint lightArrows;
    ItemHint oathToOrder;
    ItemHint ganonBossKey;
}
ComboDataHints;

typedef struct
{
    u32 flags;
    u16 count;
    u16 zero;
}
SpecialCond;

typedef struct
{
    u8              uuid[16];
    u8              playerId;
    u32             dungeonWarps[12];
    u32             dungeonEntrances[26];
    u32             mq;
    u32             preCompleted;
    u32             entrancesSong[6];
    u32             entrancesOwl[10];
    u8              config[0x40];
    SpecialCond     special[5];
    u16             maxCoins[4];
    u16             prices[PRICES_MAX];
    u16             triforcePieces;
    u16             triforceGoal;
    ComboDataHints  hints;
    s8              staticHintsImportance[20];
    u16             giZoraSapphire;
    u8              boss[12];
}
ComboConfig;

extern ComboConfig gComboConfig;

int Config_Flag(int flag);

#endif
