import "@stdlib/deploy";

message(0x1674b0a0) TokenMint {
    queryId: Int as uint64;
    amount: Int as coins;
    receiver: Address;
}

// ── Reward IDs ───────────────────────────────────────────────────────────────
const REWARD_ACTIVE_LISTENER:   Int = 1;  // repeatable, decays
const REWARD_GROWTH_AGENT:      Int = 2;  // repeatable, decays
const REWARD_ARTIST_LAUNCH:     Int = 3;  // ONE-TIME per wallet
const REWARD_TRENDSETTER:       Int = 4;  // ONE-TIME per wallet
const REWARD_SUPERFAN:          Int = 5;  // repeatable, tip-gated
const REWARD_EARLY_BELIEVER:    Int = 6;  // ONE-TIME per wallet
const REWARD_DROP_INVESTOR:     Int = 7;  // repeatable, decays

// ── Base reward amounts (nanoTOON) ───────────────────────────────────────────
const BASE_ACTIVE_LISTENER:  Int = ton("10");
const BASE_GROWTH_AGENT:     Int = ton("5");
const BASE_ARTIST_LAUNCH:    Int = ton("500");
const BASE_TRENDSETTER:      Int = ton("5000");
const BASE_EARLY_BELIEVER:   Int = ton("200");
const BASE_DROP_INVESTOR:    Int = ton("50");

// ── Safety ceilings ──────────────────────────────────────────────────────────
const EMISSION_CAP_CEILING:     Int = ton("500000");
const DEFAULT_EMISSION_CAP:     Int = ton("50000");
const DEFAULT_MIN_WALLET_AGE:   Int = 7;
const MAX_NONCE_WINDOW_SECONDS: Int = 300; // oracle payloads expire in 5 min

// ── Reserve health ───────────────────────────────────────────────────────────
const RESERVE_HALVE_THRESHOLD:  Int = 10;
const RESERVE_RECOVER_THRESHOLD:Int = 20;
const SUPERFAN_REBATE_BPS:      Int = 800;
const VIBE_MULTIPLIER_BPS:      Int = 150;

// ── Anti-abuse ───────────────────────────────────────────────────────────────
const CLAIM_COOLDOWN_SECONDS:   Int = 300;

// ── Messages ─────────────────────────────────────────────────────────────────

// Every ClaimReward carries a signed oracle attestation.
// The bot (oracle) signs: sha256(telegramId ++ walletAddress ++ rewardId ++
//   walletAgeDays ++ hasVibeStreak ++ tipAmount ++ claimId ++ expiry)
// claimId: unique uint64 — replay protection (stored in usedClaimIds)
// expiry:  unix timestamp — payload must arrive before this
// sigHigh/sigLow: Ed25519 signature split into two uint256 halves
struct Configuration {
    emissionCap: Int as coins;
    minWalletAgeDays: Int as uint32;
    targetDailyActivity: Int as uint32;
    rewardBaseActiveListener: Int as coins;
    rewardBaseGrowthAgent: Int as coins;
    rewardBaseArtistLaunch: Int as coins;
    rewardBaseTrendsetter: Int as coins;
    rewardBaseEarlyBeliever: Int as coins;
    rewardBaseDropInvestor: Int as coins;
    decayFactor: Int as uint16; // e.g., in basis points
    minThreshold: Int as coins;
    antiFarmingCoeff: Int as uint16;
}

message SetConfig {
    config: Configuration;
}

message ClaimReward {
    walletAddress:  Address;
    rewardId:       Int as uint8;
    telegramId:     Int as uint64;
    walletAgeDays:  Int as uint32;
    hasVibeStreak:  Bool;
    tipAmount:      Int as coins;
    claimId:        Int as uint64;
    expiry:         Int as uint32;
    sigHigh:        Int as uint256;
    sigLow:         Int as uint256;
    // For pairing decay:
    referrerId:     Int as uint64; // 0 if none
}

message MintAuthorized {
    recipient:    Address;
    amount:       Int as coins;
    origin:       Address;
    authorizedAt: Int as uint32;
}

message MintConfirmed {
    recipient: Address;
    amount:    Int as coins;
    origin:    Address;
}

message RewardClaimed {
    rewardId: Int as uint8;
    recipient: Address;
    amount: Int as coins;
}


// Owner-only admin messages.
message UpdateReserve    { amount: Int as coins;        }
message UpdateRegistry   { newRegistry: Address;        }
message SetGovernance    { newGovernance: Address;      }
message SetOracleKey     { newPublicKey: Int as uint256;}
message TreasuryWithdraw { amount: Int as coins; recipient: Address; }
message UpdateIdentityWeight { wallet: Address; weight: Int; }

// ── ToonVault ────────────────────────────────────────────────────────────────
//
//  Status: IMPLEMENTED (Main reward engine)
//
//  Three-layer trust stack:
//   1. Oracle attestation  — every ClaimReward carries an Ed25519 sig from
//      the bot's oracle key.  The vault verifies on-chain.  Forging a valid
//      claim requires the oracle's private key.
//   2. Nonce replay guard  — each claimId is a one-time token.  Duplicate
//      transactions or replayed packets are rejected deterministically.
//   3. Diminishing returns — repeat claimants get less over time.
//
//  Emission is dynamically throttled:
//   Individual rewards are scaled by min(1.0, target / actual_activity)
//   to prevent runaway inflation during spikes while maintaining a hard daily cap.
//
contract ToonVault with Deployable {

    owner:               Address;
    registry:            Address;
    governance:          Address;
    jettonMaster:        Address;
    oraclePublicKey:     Int as uint256;
    totalReserve:        Int as coins;
    dailyEmitted:        Int as coins;
    lastResetDay:        Int as uint32;
    halved:              Bool;
    config:              Configuration;
    dailyClaimCount:     Int as uint32;

    // ── Replay protection ────────────────────────────────────────────────────
    usedClaimIds: map<Int, Bool>;

    // Per-wallet burst throttle.
    lastClaimTimestamp: map<Int, Int>;

    // ── Diminishing returns ──────────────────────────────────────────────────
    // Tracks how many times a wallet has claimed a given reward type (lifetime).
    claimCounts: map<Int, Int>;

    // Anti-Sybil: Pairing decay.
    // Tracks how many times user A (telegramId) has been rewarded via user B (referrerId).
    // Key: sha256(telegramId + ":" + referrerId)
    pairingCounts: map<Int, Int>;

    // Multi-factor scoring State
    // unique participant count per reward type (rough approximation)
    participantEntropy: map<Int, Int>;
    // temporal distribution: track last claim per rewardId to see bursts
    lastRewardTimestamp: map<Int, Int>;

    // Sybil resistance: Identity weights (reputation/stake based)
    identityWeights: map<Address, Int>;

    // Per-epoch (day) limits
    dailyIdentityRewards: map<Int, Int as coins>;
    dailyClusterRewards:  map<Int, Int as coins>;

    // One-time reward guard.
    lifetimeClaimed: map<Int, Bool>;

    init(
        owner:               Address,
        registry:            Address,
        governance:          Address,
        jettonMaster:        Address,
        oraclePublicKey:     Int,
        totalReserve:        Int,
        dailyEmitted:        Int,
        lastResetDay:        Int,
        halved:              Bool,
        dailyClaimCount:     Int,
    ) {
        self.owner               = owner;
        self.registry            = registry;
        self.governance          = governance;
        self.jettonMaster        = jettonMaster;
        self.oraclePublicKey     = oraclePublicKey;
        self.totalReserve        = totalReserve;
        self.dailyEmitted        = dailyEmitted;
        self.lastResetDay        = lastResetDay;
        self.halved              = halved;
        self.dailyClaimCount     = dailyClaimCount;

        self.config = Configuration{
            emissionCap: ton("50000"),
            minWalletAgeDays: 7,
            targetDailyActivity: 1000,
            rewardBaseActiveListener: ton("10"),
            rewardBaseGrowthAgent: ton("5"),
            rewardBaseArtistLaunch: ton("500"),
            rewardBaseTrendsetter: ton("5000"),
            rewardBaseEarlyBeliever: ton("200"),
            rewardBaseDropInvestor: ton("50"),
            decayFactor: 1000,
            minThreshold: ton("0.01"),
            antiFarmingCoeff: 500
        };
    }

    // Allow the contract to receive TON for funding rewards
    receive() {
        // Simple funding
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Key builders
    // ─────────────────────────────────────────────────────────────────────────

    fun cooldownKey(wallet: Address): Int {
        let sb: StringBuilder = beginString();
        sb.append("cd:"); sb.append(wallet.toString());
        return sha256(sb.toString());
    }

    fun countKey(rewardId: Int, wallet: Address): Int {
        let sb: StringBuilder = beginString();
        sb.append("cnt:"); sb.append(rewardId.toString()); sb.append(":");
        sb.append(wallet.toString());
        return sha256(sb.toString());
    }

    fun pairingKey(userA: Int, userB: Int): Int {
        if (userB == 0) { return 0; }
        let sb: StringBuilder = beginString();
        sb.append("pair:"); sb.append(userA.toString()); sb.append(":");
        sb.append(userB.toString());
        return sha256(sb.toString());
    }

    fun clusterKey(clusterA: Int, clusterB: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append("cl:"); sb.append(clusterA.toString()); sb.append(":");
        sb.append(clusterB.toString());
        return sha256(sb.toString());
    }

    fun identityKey(wallet: Address): Int {
        let sb: StringBuilder = beginString();
        sb.append("id:"); sb.append(wallet.toString());
        return sha256(sb.toString());
    }

    fun onceKey(rewardId: Int, wallet: Address): Int {
        let sb: StringBuilder = beginString();
        sb.append("once:"); sb.append(rewardId.toString()); sb.append(":");
        sb.append(wallet.toString());
        return sha256(sb.toString());
    }
    fun claimIdKey(claimId: Int, day: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append("claimid:"); sb.append(claimId.toString()); sb.append(":");
        sb.append(day.toString());
        return sha256(sb.toString());
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Oracle signature verification
    // ─────────────────────────────────────────────────────────────────────────

    fun verifyOracleSignature(msg: ClaimReward): Bool {
        let payloadCell: Cell = beginCell()
            .storeUint(msg.telegramId, 64)
            .storeAddress(msg.walletAddress)
            .storeUint(msg.rewardId, 8)
            .storeUint(msg.walletAgeDays, 32)
            .storeBool(msg.hasVibeStreak)
            .storeCoins(msg.tipAmount)
            .storeUint(msg.claimId, 64)
            .storeUint(msg.expiry, 32)
            .storeUint(msg.referrerId, 64)
            .endCell();

        let h: Int = payloadCell.hash();

        let sigSlice: Slice = beginCell()
            .storeUint(msg.sigHigh, 256)
            .storeUint(msg.sigLow, 256)
            .endCell()
            .asSlice();

        return checkSignature(h, sigSlice, self.oraclePublicKey);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Emission control
    // ─────────────────────────────────────────────────────────────────────────

    fun checkDayReset(today: Int) {
        if (today > self.lastResetDay) {
            self.dailyEmitted    = 0;
            self.dailyClaimCount = 0;
            self.lastResetDay    = today;
            // Clear daily maps by not clearing but we could use a prefix in keys.
            // For simplicity in Tact/TON, we usually just accept they might grow
            // or use a new map. But map clearing is not efficient.
            // A better way is to include today in the key.
        }
    }

    fun dailyIdKey(wallet: Address, day: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append("did:"); sb.append(wallet.toString()); sb.append(":"); sb.append(day.toString());
        return sha256(sb.toString());
    }

    fun dailyClusterKey(userA: Int, userB: Int, day: Int): Int {
        let sb: StringBuilder = beginString();
        sb.append("dcl:"); sb.append(userA.toString()); sb.append(":");
        sb.append(userB.toString()); sb.append(":"); sb.append(day.toString());
        return sha256(sb.toString());
    }

    fun _recalcHalved() {
        let reservePct: Int = (self.totalReserve * 100) / ton("1000000");
        if (reservePct <= RESERVE_HALVE_THRESHOLD)   { self.halved = true;  }
        if (reservePct >= RESERVE_RECOVER_THRESHOLD) { self.halved = false; }
    }
    fun halvedBaseCap(): Int {
        let cap: Int = self.config.emissionCap;
        let reservePct: Int = (self.totalReserve * 100) / ton("1000000");
        if (reservePct <= RESERVE_HALVE_THRESHOLD)   { self.halved = true;  }
        if (reservePct >= RESERVE_RECOVER_THRESHOLD) { self.halved = false; }
        if (self.halved) { cap = cap / 2; }
        return cap;
    }

    // Feedback multiplier: rewards shrink if activity exceeds target.
    //   mult = min(10000, (target * 10000) / max(1, actual))
    fun activityMultiplier(): Int {
        if (self.config.targetDailyActivity == 0) { return 10000; }
        let actual: Int = self.dailyClaimCount;
        if (actual <= self.config.targetDailyActivity) { return 10000; }
        
        let ratio: Int = (self.config.targetDailyActivity * 10000) / actual;
        if (ratio < 1000) { ratio = 1000; } // Floor at 10%
        return ratio;
    }

    fun applyMultiplier(amount: Int, hasStreak: Bool): Int {
        let res: Int = amount;
        if (hasStreak) { res = (res * VIBE_MULTIPLIER_BPS) / 10000; }
        
        // Apply feedback multiplier (bps)
        let feedback: Int = self.activityMultiplier();
        res = (res * feedback) / 10000;
        
        return res;
    }

    fun decayedReward(base: Int, claimCount: Int): Int {
        if (claimCount == 0) { return base; }
        if (claimCount == 1) { return (base * 75)  / 100; }
        if (claimCount == 2) { return (base * 50)  / 100; }
        if (claimCount <= 9) { return (base * 25)  / 100; }
        return (base * 10) / 100;
    }

    // Pairing decay: reduces reward for repeated user-pair interactions.
    fun pairingDecay(amount: Int, pairCount: Int): Int {
        if (pairCount == 0) { return amount; }
        if (pairCount == 1) { return (amount * 80) / 100; }
        if (pairCount == 2) { return (amount * 60) / 100; }
        return (amount * 40) / 100; // Floor at 40% for pairings
    }

    fun multiFactorScore(amount: Int, msg: ClaimReward): Int {
        let res: Int = amount;
        let rId: Int = msg.rewardId;

        // 1. Interaction Entropy (variance of participants)
        let entropy: Int? = self.participantEntropy.get(rId);
        let eVal: Int = entropy != null ? entropy!! : 0;
        if (eVal > 100) { res = (res * 110) / 100; }

        // 2. Temporal Distribution (spread over time vs bursts)
        let lastT: Int? = self.lastRewardTimestamp.get(rId);
        if (lastT != null) {
            let delta: Int = now() - lastT!!;
            if (delta < 10) {
                res = (res * 50) / 100;
            }
        }

        // 3. Identity Weighting (Sybil resistance)
        let weight: Int? = self.identityWeights.get(msg.walletAddress);
        let wVal: Int = weight != null ? weight!! : 100; // Default weight 100%
        res = (res * wVal) / 100;

        // Update entropy if it's a first-time claimer for this reward (simplified check)
        let ckKey: Int = self.countKey(rId, msg.walletAddress);
        if (self.claimCounts.get(ckKey) == null) {
            self.participantEntropy.set(rId, eVal + 1);
        }

        self.lastRewardTimestamp.set(rId, now());

        return res;
    }

    fun isOneTimeReward(rewardId: Int): Bool {
        return rewardId == REWARD_ARTIST_LAUNCH ||
               rewardId == REWARD_TRENDSETTER   ||
               rewardId == REWARD_EARLY_BELIEVER;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Core claim handler
    // ─────────────────────────────────────────────────────────────────────────

    receive(msg: ClaimReward) {
        // ── 0. Boundary validation ───────────────────────────────────────
        require(msg.rewardId >= REWARD_ACTIVE_LISTENER && msg.rewardId <= REWARD_DROP_INVESTOR, "ToonVault: invalid rewardId");
        require(msg.walletAddress != newAddress(0, 0), "ToonVault: invalid wallet address");

        // ── 1. Oracle signature verification ─────────────────────────────
        require(self.verifyOracleSignature(msg), "ToonVault: invalid oracle signature");

        // ── 2. Payload freshness ──────────────────────────────────────────
        require(msg.expiry >= now(), "ToonVault: signed payload has expired");

        // ── 3. ClaimId replay guard ───────────────────────────────────────
        let dayKey: Int = self.claimIdKey(msg.claimId, today);
        require(self.usedClaimIds.get(dayKey) == null, "ToonVault: claimId already used");
        self.usedClaimIds.set(dayKey, true);

        // ── 4. Wallet eligibility ─────────────────────────────────────────
        require(msg.walletAgeDays >= self.config.minWalletAgeDays, "ToonVault: wallet too new");
        require(msg.telegramId > 0, "ToonVault: no Telegram identity");

        // ── 5. Daily reset ────────────────────────────────────────────────
        let today: Int = now() / 86400;
        self.checkDayReset(today);

        // ── 6. Per-wallet cooldown ────────────────────────────────────────
        let cKey: Int = self.cooldownKey(msg.walletAddress);
        let lastClaim: Int? = self.lastClaimTimestamp.get(cKey);
        if (lastClaim != null) {
            require(now() >= lastClaim!! + CLAIM_COOLDOWN_SECONDS, "ToonVault: claim cooldown active");
        }

        // ── 7. One-time reward guard ──────────────────────────────────────
        let oKey: Int = self.onceKey(msg.rewardId, msg.walletAddress);
        if (self.isOneTimeReward(msg.rewardId)) {
            require(self.lifetimeClaimed.get(oKey) == null, "ToonVault: one-time reward already claimed");
        }

        // ── 8. Emission gate ─────────────────────────────────────────────
        let cap: Int = self.halvedBaseCap();
        require(self.dailyEmitted < cap, "ToonVault: daily emission cap reached");

        // ── 9. Reward computation ────────────────────────────────────────
        let baseReward: Int = 0;
        if      (msg.rewardId == REWARD_ACTIVE_LISTENER) { baseReward = self.config.rewardBaseActiveListener; }
        else if (msg.rewardId == REWARD_GROWTH_AGENT)    { baseReward = self.config.rewardBaseGrowthAgent;    }
        else if (msg.rewardId == REWARD_ARTIST_LAUNCH)   { baseReward = self.config.rewardBaseArtistLaunch;   }
        else if (msg.rewardId == REWARD_TRENDSETTER)     { baseReward = self.config.rewardBaseTrendsetter;     }
        else if (msg.rewardId == REWARD_EARLY_BELIEVER)  { baseReward = self.config.rewardBaseEarlyBeliever;  }
        else if (msg.rewardId == REWARD_DROP_INVESTOR)   { baseReward = self.config.rewardBaseDropInvestor;   }
        else if (msg.rewardId == REWARD_SUPERFAN) {
            require(msg.tipAmount >= ton("100"), "ToonVault: tip too small");
            baseReward = (msg.tipAmount * SUPERFAN_REBATE_BPS) / 10000;
        }

        require(baseReward > 0, "ToonVault: unknown reward ID");

        // ── 10. Diminishing returns (lifetime) ───────────────────────────
        let ckKey: Int = self.countKey(msg.rewardId, msg.walletAddress);
        let claimCount: Int = self.claimCounts.get(ckKey) != null ? self.claimCounts.get(ckKey)!! : 0;

        let reward: Int = 0;
        if (self.isOneTimeReward(msg.rewardId)) {
            reward = baseReward;
        } else {
            reward = self.decayedReward(baseReward, claimCount);
        }

        // ── 11. Anti-Sybil: Pairing decay ─────────────────────────────────
        let pKey: Int = self.pairingKey(msg.telegramId, msg.referrerId);
        if (pKey != 0) {
            let pairCount: Int = self.pairingCounts.get(pKey) != null ? self.pairingCounts.get(pKey)!! : 0;
            reward = self.pairingDecay(reward, pairCount);
            self.pairingCounts.set(pKey, pairCount + 1);
        }

        // ── 12. Vibe streak & Activity feedback ───────────────────────────
        reward = self.applyMultiplier(reward, msg.hasVibeStreak);

        // ── 12b. Multi-factor scoring ─────────────────────────────────────
        reward = self.multiFactorScore(reward, msg);

        // ── 12c. Per-epoch caps ───────────────────────────────────────────
        let idKey: Int = self.dailyIdKey(msg.walletAddress, today);
        let idEarned: Int = self.dailyIdentityRewards.get(idKey) != null ? self.dailyIdentityRewards.get(idKey)!! : 0;
        let idCap: Int = ton("1000"); // 1000 $TOON per identity per day
        if (idEarned + reward > idCap) {
            reward = idCap - idEarned;
        }
        if (reward < 0) { reward = 0; }

        let clKey: Int = self.dailyClusterKey(msg.telegramId, msg.referrerId, today);
        if (msg.referrerId > 0) {
            let clEarned: Int = self.dailyClusterRewards.get(clKey) != null ? self.dailyClusterRewards.get(clKey)!! : 0;
            let clCap: Int = ton("2000"); // 2000 $TOON per cluster per day
            if (clEarned + reward > clCap) {
                reward = clCap - clEarned;
            }
        }
        if (reward < 0) { reward = 0; }

        // ── 13. Clamp to remaining daily budget ───────────────────────────
        let remaining: Int = cap - self.dailyEmitted;
        if (reward > remaining) { reward = remaining; }

        // Safety floor: 0.0001 TON (prevents rounding to 0)
        if (reward < ton("0.0001") && reward > 0) { reward = ton("0.0001"); }

        require(self.totalReserve >= reward, "ToonVault: insufficient reserve");

        // ── 14. Commit state ─────────────────────────────────────────────
        self.totalReserve   = self.totalReserve - reward;
        self.dailyEmitted   = self.dailyEmitted + reward;
        self.dailyClaimCount = self.dailyClaimCount + 1;
        self.lastClaimTimestamp.set(cKey, now());
        self.claimCounts.set(ckKey, claimCount + 1);
        self.dailyIdentityRewards.set(idKey, idEarned + reward);
        if (msg.referrerId > 0) {
            let clEarned: Int = self.dailyClusterRewards.get(clKey) != null ? self.dailyClusterRewards.get(clKey)!! : 0;
            self.dailyClusterRewards.set(clKey, clEarned + reward);
        }

        if (self.isOneTimeReward(msg.rewardId)) {
            self.lifetimeClaimed.set(oKey, true);
        }

        emit(RewardClaimed{rewardId: msg.rewardId, recipient: msg.walletAddress, amount: reward}.toCell());

        // ── 15. Send Jetton Reward ─────────────────────────────────────────
        send(SendParameters{
            to:    self.jettonMaster,
            value: ton("0.05"), // Gas for JettonMaster -> Wallet
            mode:  SendPayGasSeparately,
            body:  TokenMint{
                queryId: 0,
                amount: reward,
                receiver: msg.walletAddress
            }.toCell()
        });
    }

    // ── Registry mint authorization ──────────────────────────────────────────
    receive(msg: MintAuthorized) {
        require(sender() == self.registry,
            "ToonVault: only registry can authorize minting");
        require(self.totalReserve >= msg.amount, "ToonVault: insufficient reserve");

        self.totalReserve = self.totalReserve - msg.amount;

        // 1. Send TokenMint to JettonMaster
        send(SendParameters{
            to:    self.jettonMaster,
            value: ton("0.05"),
            mode:  SendPayGasSeparately,
            body:  TokenMint{
                queryId: 0,
                amount: msg.amount,
                receiver: msg.recipient
            }.toCell()
        });

        // 2. Notify Registry of success
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            body: MintConfirmed{
                recipient: msg.recipient,
                amount: msg.amount,
                origin: msg.origin
            }.toCell()
        });
    }

    // ── Registry-gated configuration update ──────────────────────────────────
    receive(msg: SetConfig) {
        require(sender() == self.registry, "ToonVault: only registry can update config");
        self.config = msg.config;
    }

    // ── Owner-only admin ─────────────────────────────────────────────────────

    receive(msg: UpdateReserve) {
        require(sender() == self.owner, "ToonVault: not owner");
        self.totalReserve = self.totalReserve + msg.amount;
    }

    receive(msg: UpdateRegistry) {
        require(sender() == self.owner, "ToonVault: not owner");
        self.registry = msg.newRegistry;
    }

    receive(msg: SetGovernance) {
        require(sender() == self.owner, "ToonVault: not owner");
        self.governance = msg.newGovernance;
    }

    receive(msg: SetOracleKey) {
        require(sender() == self.owner, "ToonVault: not owner");
        require(msg.newPublicKey != 0, "ToonVault: zero oracle key");
        self.oraclePublicKey = msg.newPublicKey;
        emit("OracleKeyRotated".asComment());
    }

    receive(msg: TreasuryWithdraw) {
        require(sender() == self.owner, "ToonVault: not owner");
        require(self.totalReserve >= msg.amount, "ToonVault: insufficient reserve");
        self.totalReserve = self.totalReserve - msg.amount;
        send(SendParameters{
            to:    msg.recipient,
            value: msg.amount,
            mode:  0,  // Bounce-able: reverts state if send fails
            body:  "withdrawal".asComment()
        });
    }

    receive(msg: UpdateIdentityWeight) {
        require(sender() == self.registry || sender() == self.owner, "ToonVault: unauthorized identity weight update");
        self.identityWeights.set(msg.wallet, msg.weight);
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    get fun totalReserve(): Int       { return self.totalReserve;       }
    get fun dailyEmitted(): Int       { return self.dailyEmitted;       }
    get fun dailyClaimCount(): Int    { return self.dailyClaimCount;    }
    get fun isHalved(): Bool          { return self.halved;             }
    get fun getConfig(): Configuration { return self.config; }
    get fun currentEmissionCap(): Int { return self.config.emissionCap;        }
    get fun minWalletAgeDays(): Int   { return self.config.minWalletAgeDays;   }
    get fun effectiveDailyCap(): Int  { return self.halvedBaseCap();     }
    get fun governance(): Address     { return self.governance;         }

    get fun walletClaimCount(rewardId: Int, wallet: Address): Int {
        let k: Int = self.countKey(rewardId, wallet);
        let v: Int? = self.claimCounts.get(k);
        return v != null ? v!! : 0;
    }

    get fun isOneTimeClaimed(rewardId: Int, wallet: Address): Bool {
        return self.lifetimeClaimed.get(self.onceKey(rewardId, wallet)) != null;
    }

    get fun isClaimIdUsed(claimId: Int): Bool {
        let dayKey: Int = self.claimIdKey(claimId, now() / 86400);
        return self.usedClaimIds.get(dayKey) != null;
    }
}