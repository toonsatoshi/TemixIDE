// ============================================================
// PriceOracle.tact
// ============================================================
// Push-model price oracle with multi-guardian validation for
// TonLend — an Aave-inspired lending protocol on TON.
//
// ARCHITECTURE INNOVATION: "Threshold Consensus Oracle"
//
//   Unlike Aave's Chainlink-dependent single-source oracle,
//   this contract implements an on-chain guardian quorum:
//
//   • N guardians each push price updates independently.
//   • A price only becomes "accepted" once a configurable
//     threshold (e.g. 3 of 5) guardians agree within a
//     tolerance band (e.g. ±2% of each other).
//   • Outliers are automatically rejected — no single
//     guardian can manipulate the accepted price.
//   • A time-lock enforces a minimum staleness window so
//     that a fast attacker cannot spam the oracle.
//   • Emergency pause: owner can freeze the oracle;
//     LendingPool halts borrows when oracle is frozen.
//
//   This is inspired by MakerDAO's OSM (Oracle Security
//   Module) but adapted for TON's async message model.
//
// FLOW:
//   Guardian → PriceOracle: PushPrice
//   PriceOracle accumulates N guardian submissions
//   When threshold is reached → median is computed
//   PriceOracle → LendingPool: PriceUpdate (push)
// ============================================================

import "@stdlib/deploy";

// ─── Messages ────────────────────────────────────────────────

/// Guardian pushes a new price observation.
message PushPrice {
    asset:   Address;  // Jetton master address
    price:   Int;      // USD price in 1e8 (e.g. $3.50 = 350_000_000)
    roundId: Int as uint64; // monotonically increasing round identifier
}

/// Admin adds a guardian address.
message AddGuardian {
    guardian: Address;
}

/// Admin removes a guardian.
message RemoveGuardian {
    guardian: Address;
}

/// Admin updates the required quorum threshold.
message SetThreshold {
    threshold: Int;
}

/// Admin updates the price deviation tolerance.
message SetTolerance {
    toleranceBps: Int;  // e.g. 200 = 2%
}

/// Admin registers a new tracked asset.
message RegisterAsset {
    asset:       Address;
    lendingPool: Address;  // which pool to notify
}

/// Emergency pause/unpause.
message SetPaused {
    paused: Bool;
}

// ─── Structs ─────────────────────────────────────────────────

/// One guardian's submission for a given round.
struct GuardianSubmission {
    price:   Int;
    roundId: Int as uint64;
    submittedAt: Int;  // timestamp
}

/// Aggregated state for a single asset.
struct AssetOracleState {
    lendingPool:      Address;
    acceptedPrice:    Int;
    acceptedAt:       Int;      // timestamp of last accepted price
    currentRoundId:   Int as uint64;
    submissionCount:  Int;
    // Guardian → submission mapping (max 10 guardians for gas)
    sub0: GuardianSubmission?;
    sub1: GuardianSubmission?;
    sub2: GuardianSubmission?;
    sub3: GuardianSubmission?;
    sub4: GuardianSubmission?;
    sub5: GuardianSubmission?;
    sub6: GuardianSubmission?;
    sub7: GuardianSubmission?;
    sub8: GuardianSubmission?;
    sub9: GuardianSubmission?;
}

// ─── Forwarded to LendingPool ─────────────────────────────────
message PriceUpdate {
    asset: Address;
    price: Int;
}

// ─── Constants ───────────────────────────────────────────────

const MAX_GUARDIANS: Int    = 10;
const MAX_PRICE_AGE: Int    = 3600;  // prices stale after 1 hour
const MIN_ROUND_INTERVAL: Int = 60;  // guardians can only push once per minute

// ─── Contract ────────────────────────────────────────────────

contract PriceOracle with Deployable {

    owner:         Address;
    paused:        Bool;
    threshold:     Int;   // number of guardians required for consensus
    toleranceBps:  Int;   // price deviation tolerance in basis points
    guardianCount: Int;

    // Guardian registry (indices 0–9, null = slot empty)
    guardian0: Address?;
    guardian1: Address?;
    guardian2: Address?;
    guardian3: Address?;
    guardian4: Address?;
    guardian5: Address?;
    guardian6: Address?;
    guardian7: Address?;
    guardian8: Address?;
    guardian9: Address?;

    // Per-asset oracle state
    assets: map<Address, AssetOracleState>;

    // Track last submission time per guardian to prevent spam
    lastSubmit: map<Address, Int>;

    init(owner: Address, threshold: Int, toleranceBps: Int) {
        self.owner         = owner;
        self.paused        = false;
        self.threshold     = threshold;
        self.toleranceBps  = toleranceBps;
        self.guardianCount = 0;
        self.guardian0     = null;
        self.guardian1     = null;
        self.guardian2     = null;
        self.guardian3     = null;
        self.guardian4     = null;
        self.guardian5     = null;
        self.guardian6     = null;
        self.guardian7     = null;
        self.guardian8     = null;
        self.guardian9     = null;
        self.assets        = emptyMap();
        self.lastSubmit    = emptyMap();
    }

    // ── Admin: register asset ────────────────────────────────
    receive(msg: RegisterAsset) {
        require(sender() == self.owner, "Only owner");
        require(self.assets.get(msg.asset) == null, "Asset registered");
        self.assets.set(msg.asset, AssetOracleState{
            lendingPool:     msg.lendingPool,
            acceptedPrice:   0,
            acceptedAt:      0,
            currentRoundId:  0,
            submissionCount: 0,
            sub0: null, sub1: null, sub2: null, sub3: null, sub4: null,
            sub5: null, sub6: null, sub7: null, sub8: null, sub9: null
        });
    }

    // ── Admin: add guardian ──────────────────────────────────
    receive(msg: AddGuardian) {
        require(sender() == self.owner, "Only owner");
        require(self.guardianCount < MAX_GUARDIANS, "Max guardians reached");
        require(!self._isGuardian(msg.guardian), "Already a guardian");

        self._setGuardianSlot(self.guardianCount, msg.guardian);
        self.guardianCount = self.guardianCount + 1;
    }

    // ── Admin: remove guardian ───────────────────────────────
    receive(msg: RemoveGuardian) {
        require(sender() == self.owner, "Only owner");
        require(self._isGuardian(msg.guardian), "Not a guardian");

        let idx: Int = self._guardianIndex(msg.guardian);
        self._setGuardianSlot(idx, null);
        // Compact: move last guardian into the removed slot
        if (idx < self.guardianCount - 1) {
            let last: Address? = self._getGuardianSlot(self.guardianCount - 1);
            self._setGuardianSlot(idx, last!!);
            self._setGuardianSlot(self.guardianCount - 1, null);
        }
        self.guardianCount = self.guardianCount - 1;
    }

    // ── Admin: update threshold ──────────────────────────────
    receive(msg: SetThreshold) {
        require(sender() == self.owner, "Only owner");
        require(msg.threshold > 0 && msg.threshold <= self.guardianCount, "Invalid threshold");
        self.threshold = msg.threshold;
    }

    // ── Admin: update tolerance ──────────────────────────────
    receive(msg: SetTolerance) {
        require(sender() == self.owner, "Only owner");
        require(msg.toleranceBps <= 5_000, "Tolerance too wide"); // max 50%
        self.toleranceBps = msg.toleranceBps;
    }

    // ── Admin: pause/unpause ─────────────────────────────────
    receive(msg: SetPaused) {
        require(sender() == self.owner, "Only owner");
        self.paused = msg.paused;
    }

    // ── Guardian: push price observation ─────────────────────
    receive(msg: PushPrice) {
        require(!self.paused, "Oracle paused");
        require(self._isGuardian(sender()), "Not a guardian");
        require(msg.price > 0, "Invalid price");

        // Enforce minimum round interval (anti-spam)
        let lastTime: Int? = self.lastSubmit.get(sender());
        if (lastTime != null) {
            require(now() - lastTime!! >= MIN_ROUND_INTERVAL, "Too frequent");
        }
        self.lastSubmit.set(sender(), now());

        let state: AssetOracleState? = self.assets.get(msg.asset);
        require(state != null, "Asset not registered");
        let s: AssetOracleState = state!!;

        // Start a new round if this is a fresh roundId
        if (msg.roundId > s.currentRoundId) {
            s = self._resetRound(s, msg.roundId);
        }
        require(msg.roundId == s.currentRoundId, "Stale round");

        // Record this guardian's submission
        let guardianIdx: Int = self._guardianIndex(sender());
        let submission: GuardianSubmission = GuardianSubmission{
            price:       msg.price,
            roundId:     msg.roundId,
            submittedAt: now()
        };
        s = self._setSubmission(s, guardianIdx, submission);
        s.submissionCount = s.submissionCount + 1;

        // Check if we have reached quorum
        if (s.submissionCount >= self.threshold) {
            let result: Int = self._tryReachConsensus(s);
            if (result > 0) {
                // Consensus reached — push accepted price to LendingPool
                s.acceptedPrice  = result;
                s.acceptedAt     = now();
                // Push to LendingPool
                send(SendParameters{
                    to:    s.lendingPool,
                    value: ton("0.02"),
                    mode:  SendIgnoreErrors,
                    bounce: false,
                    body:  PriceUpdate{
                        asset: msg.asset,
                        price: result
                    }.toCell()
                });
            }
        }

        self.assets.set(msg.asset, s);
    }

    // ── Internal: compute median of valid submissions ─────────
    //    Valid = within toleranceBps of the initial submission
    fun _tryReachConsensus(s: AssetOracleState): Int {
        // Collect all non-null prices
        let prices: map<Int, Int> = emptyMap();
        let count: Int = 0;

        let i: Int = 0;
        while (i < MAX_GUARDIANS) {
            let sub: GuardianSubmission? = self._getSubmission(s, i);
            if (sub != null) {
                prices.set(count, (sub!!).price);
                count = count + 1;
            }
            i = i + 1;
        }

        if (count < self.threshold) { return 0; }

        // Simple median: sort the prices (insertion sort, max 10 elements)
        let j: Int = 1;
        while (j < count) {
            let key: Int = prices.get(j)!!;
            let k: Int = j - 1;
            while (k >= 0 && prices.get(k)!! > key) {
                prices.set(k + 1, prices.get(k)!!);
                k = k - 1;
            }
            prices.set(k + 1, key);
            j = j + 1;
        }

        // Median
        let median: Int = 0;
        if (count % 2 == 1) {
            median = prices.get(count / 2)!!;
        } else {
            median = (prices.get(count / 2 - 1)!! + prices.get(count / 2)!!) / 2;
        }

        // Validate: count how many prices are within tolerance of median
        let validCount: Int = 0;
        let m: Int = 0;
        while (m < count) {
            let p: Int = prices.get(m)!!;
            let deviation: Int = 0;
            if (p >= median) {
                deviation = (p - median) * 10_000 / median;
            } else {
                deviation = (median - p) * 10_000 / median;
            }
            if (deviation <= self.toleranceBps) {
                validCount = validCount + 1;
            }
            m = m + 1;
        }

        if (validCount >= self.threshold) {
            return median;
        }
        return 0;  // no consensus
    }

    // ── Internal: reset round state ───────────────────────────
    fun _resetRound(s: AssetOracleState, newRoundId: Int): AssetOracleState {
        return AssetOracleState{
            lendingPool:     s.lendingPool,
            acceptedPrice:   s.acceptedPrice,
            acceptedAt:      s.acceptedAt,
            currentRoundId:  newRoundId,
            submissionCount: 0,
            sub0: null, sub1: null, sub2: null, sub3: null, sub4: null,
            sub5: null, sub6: null, sub7: null, sub8: null, sub9: null
        };
    }

    // ── Internal: guardian slot accessors (0–9) ───────────────
    fun _isGuardian(addr: Address): Bool {
        return self._guardianIndex(addr) >= 0;
    }

    fun _guardianIndex(addr: Address): Int {
        if (self.guardian0 != null && self.guardian0!! == addr) { return 0; }
        if (self.guardian1 != null && self.guardian1!! == addr) { return 1; }
        if (self.guardian2 != null && self.guardian2!! == addr) { return 2; }
        if (self.guardian3 != null && self.guardian3!! == addr) { return 3; }
        if (self.guardian4 != null && self.guardian4!! == addr) { return 4; }
        if (self.guardian5 != null && self.guardian5!! == addr) { return 5; }
        if (self.guardian6 != null && self.guardian6!! == addr) { return 6; }
        if (self.guardian7 != null && self.guardian7!! == addr) { return 7; }
        if (self.guardian8 != null && self.guardian8!! == addr) { return 8; }
        if (self.guardian9 != null && self.guardian9!! == addr) { return 9; }
        return -1;
    }

    fun _getGuardianSlot(idx: Int): Address? {
        if (idx == 0) { return self.guardian0; }
        if (idx == 1) { return self.guardian1; }
        if (idx == 2) { return self.guardian2; }
        if (idx == 3) { return self.guardian3; }
        if (idx == 4) { return self.guardian4; }
        if (idx == 5) { return self.guardian5; }
        if (idx == 6) { return self.guardian6; }
        if (idx == 7) { return self.guardian7; }
        if (idx == 8) { return self.guardian8; }
        if (idx == 9) { return self.guardian9; }
        return null;
    }

    fun _setGuardianSlot(idx: Int, addr: Address?) {
        if (idx == 0) { self.guardian0 = addr; return; }
        if (idx == 1) { self.guardian1 = addr; return; }
        if (idx == 2) { self.guardian2 = addr; return; }
        if (idx == 3) { self.guardian3 = addr; return; }
        if (idx == 4) { self.guardian4 = addr; return; }
        if (idx == 5) { self.guardian5 = addr; return; }
        if (idx == 6) { self.guardian6 = addr; return; }
        if (idx == 7) { self.guardian7 = addr; return; }
        if (idx == 8) { self.guardian8 = addr; return; }
        if (idx == 9) { self.guardian9 = addr; return; }
    }

    // ── Submission slot accessors ─────────────────────────────
    fun _getSubmission(s: AssetOracleState, idx: Int): GuardianSubmission? {
        if (idx == 0) { return s.sub0; }
        if (idx == 1) { return s.sub1; }
        if (idx == 2) { return s.sub2; }
        if (idx == 3) { return s.sub3; }
        if (idx == 4) { return s.sub4; }
        if (idx == 5) { return s.sub5; }
        if (idx == 6) { return s.sub6; }
        if (idx == 7) { return s.sub7; }
        if (idx == 8) { return s.sub8; }
        if (idx == 9) { return s.sub9; }
        return null;
    }

    fun _setSubmission(s: AssetOracleState, idx: Int, sub: GuardianSubmission): AssetOracleState {
        if (idx == 0) { s.sub0 = sub; return s; }
        if (idx == 1) { s.sub1 = sub; return s; }
        if (idx == 2) { s.sub2 = sub; return s; }
        if (idx == 3) { s.sub3 = sub; return s; }
        if (idx == 4) { s.sub4 = sub; return s; }
        if (idx == 5) { s.sub5 = sub; return s; }
        if (idx == 6) { s.sub6 = sub; return s; }
        if (idx == 7) { s.sub7 = sub; return s; }
        if (idx == 8) { s.sub8 = sub; return s; }
        if (idx == 9) { s.sub9 = sub; return s; }
        return s;
    }

    // ── Getters ───────────────────────────────────────────────

    get fun price(asset: Address): Int {
        let s: AssetOracleState? = self.assets.get(asset);
        if (s == null) { return 0; }
        return (s!!).acceptedPrice;
    }

    get fun priceAge(asset: Address): Int {
        let s: AssetOracleState? = self.assets.get(asset);
        if (s == null) { return -1; }
        return now() - (s!!).acceptedAt;
    }

    get fun isPriceFresh(asset: Address): Bool {
        return self.priceAge(asset) <= MAX_PRICE_AGE;
    }

    get fun guardianCount(): Int {
        return self.guardianCount;
    }

    get fun isGuardian(addr: Address): Bool {
        return self._isGuardian(addr);
    }

    get fun isPaused(): Bool {
        return self.paused;
    }
}
