import "@stdlib/deploy";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages
// ─────────────────────────────────────────────────────────────────────────────

message PurchaseSlice {
    amount: Int as coins;
}

// Vault deposits royalty income. Pull model — investors claim individually.
message DepositRoyalty { }

// Investor pulls their unclaimed pro-rata royalty share.
message ClaimRoyaltyShare { }

// Investor reclaims investment after a failed raise.
message Refund { }

// Owner emergency exit: recover funds if contract is stuck.
// Only callable when raise has been finalized (locked).
message RecoverStuckFunds {
    recipient: Address;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToonDrop
// ─────────────────────────────────────────────────────────────────────────────
//
//  Royalty accounting is a pure pull model:
//    claimable(investor) = floor(invested * totalRoyalties / totalRaised)
//                        − alreadyClaimed(investor)
//
//  All arithmetic uses integer floor division throughout.
//  Dust threshold prevents micro-sends that cost more gas than they're worth.
//
//  Stuck-fund recovery: if the contract ends up holding TON that cannot be
//  distributed (e.g., rounding residue after all investors have claimed),
//  the artist can recover via RecoverStuckFunds after the raise is locked.
//
contract ToonDrop with Deployable {

    // ── Identity ──────────────────────────────────────────────────────────────
    artist:   Address;
    trackId:  Int as uint256;
    registry: Address;
    vault:    Address;

    // ── Offering parameters (immutable post-deploy) ───────────────────────────
    royaltyPercentage: Int as uint16;  // Basis points (1000 = 10%)
    raiseTarget:       Int as coins;
    slicePrice:        Int as coins;
    deadline:          Int as uint32;

    // ── Offering state ────────────────────────────────────────────────────────
    currentRaise:  Int as coins;  // Sum of all investments (capped at raiseTarget)
    isLocked:      Bool;
    isSuccessful:  Bool;
    investorCount: Int as uint32;

    investments: map<Address, Int>;  // investor → invested amount

    // ── Royalty accounting ────────────────────────────────────────────────────
    totalRoyaltiesReceived: Int as coins;
    claimedRoyalties:       map<Address, Int>;  // investor → TON already claimed

    // Minimum TON worth sending (avoids dust transactions).
    // Set to 0.01 TON — below this, gas cost exceeds the payout.
    const DUST_THRESHOLD: Int = ton("0.01");
    // Gas reserve kept per DepositRoyalty to keep accounting exact.
    const GAS_RESERVE:    Int = ton("0.01");

    // ── Constructor ───────────────────────────────────────────────────────────

    init(
        artist:     Address,
        trackId:    Int,
        registry:   Address,
        vault:      Address,
        royaltyPct: Int,
        target:     Int,
        price:      Int,
        duration:   Int
    ) {
        self.artist            = artist;
        self.trackId           = trackId;
        self.registry          = registry;
        self.vault             = vault;
        self.royaltyPercentage = royaltyPct;
        self.raiseTarget       = target;
        self.slicePrice        = price;
        self.deadline          = now() + duration;

        self.currentRaise           = 0;
        self.isLocked               = false;
        self.isSuccessful           = false;
        self.investorCount          = 0;
        self.totalRoyaltiesReceived = 0;
    }

    // ── Offering logic ────────────────────────────────────────────────────────

    receive(msg: PurchaseSlice) {
        require(!self.isLocked,                    "ToonDrop: offering locked");
        require(now() <= self.deadline,            "ToonDrop: deadline passed");
        require(msg.amount >= self.slicePrice,     "ToonDrop: below slice price");

        let investor: Address = sender();

        // Overshoot protection: cap contribution so currentRaise never
        // exceeds raiseTarget (prevents accounting drift).
        let headroom: Int = self.raiseTarget - self.currentRaise;
        let accepted: Int = msg.amount;
        if (accepted > headroom) { accepted = headroom; }
        
        // Refund excess TON to sender immediately
        let excess: Int = msg.amount - accepted;
        if (excess > 0) {
            send(SendParameters{
                to:    investor,
                value: excess,
                mode:  SendPayGasSeparately,
                body:  "ToonDrop: refunding excess contribution".asComment()
            });
        }

        let existing: Int? = self.investments.get(investor);
        if (existing == null) {
            self.investorCount = self.investorCount + 1;
            self.investments.set(investor, accepted);
        } else {
            self.investments.set(investor, existing!! + accepted);
        }

        self.currentRaise = self.currentRaise + accepted;

        // Exact comparison: currentRaise == raiseTarget triggers success.
        // (Never exceeds due to headroom cap above.)
        if (self.currentRaise >= self.raiseTarget) {
            self.finalize(true);
        }
    }

    receive("CheckDeadline") {
        if (!self.isLocked && now() > self.deadline) {
            self.finalize(self.currentRaise >= self.raiseTarget);
        }
    }

    fun finalize(success: Bool) {
        self.isLocked     = true;
        self.isSuccessful = success;

        if (success) {
            // Split currentRaise:
            // protocolFee = currentRaise * royaltyPercentage / 10000 (bps)
            // artistShare = currentRaise - protocolFee
            let protocolFee: Int = (self.currentRaise * self.royaltyPercentage) / 10000;
            let artistShare: Int = self.currentRaise - protocolFee;

            if (artistShare > 0) {
                send(SendParameters{
                    to:   self.artist,
                    value: artistShare,
                    mode:  SendIgnoreErrors,
                    body:  "drop_raise_succeeded_artist".asComment()
                });
            }

            if (protocolFee > 0) {
                send(SendParameters{
                    to:   self.vault,
                    value: protocolFee,
                    mode:  SendIgnoreErrors,
                    body:  "drop_protocol_fee".asComment()
                });
            }
        }
    }

    // ── Royalty accumulation (pull model) ─────────────────────────────────────

    receive(msg: DepositRoyalty) {
        require(sender() == self.vault,
            "ToonDrop: only vault may deposit royalties");
        require(self.isSuccessful,
            "ToonDrop: raise not successful");

        // Subtract gas reserve so accounting stays exact and the contract
        // always retains enough TON to pay future transaction costs.
        let incoming: Int = context().value - self.GAS_RESERVE;
        require(incoming > 0, "ToonDrop: deposit too small to cover gas reserve");

        self.totalRoyaltiesReceived = self.totalRoyaltiesReceived + incoming;

        emit("RoyaltyDeposited".asComment());
    }

    // ── Investor claim ────────────────────────────────────────────────────────

    receive(msg: ClaimRoyaltyShare) {
        require(self.isSuccessful,
            "ToonDrop: raise not successful");
        require(self.totalRoyaltiesReceived > 0,
            "ToonDrop: no royalties deposited yet");

        let investor: Address = sender();
        let invested: Int? = self.investments.get(investor);
        require(invested != null && invested!! > 0,
            "ToonDrop: no investment from caller");

        // Pro-rata share — integer floor division throughout.
        // totalShare = floor(invested * totalRoyalties / totalRaised)
        // Using (a * b) / c ordering: multiply first to maximise precision,
        // then divide once (minimises accumulated rounding error).
        let totalShare: Int = (invested!! * self.totalRoyaltiesReceived)
                              / self.currentRaise;

        let prevClaim: Int? = self.claimedRoyalties.get(investor);
        let alreadyClaimed: Int = prevClaim != null ? prevClaim!! : 0;

        let claimable: Int = totalShare - alreadyClaimed;

        require(claimable >= self.DUST_THRESHOLD,
            "ToonDrop: claimable amount below dust threshold");

        // Commit before send (checks-effects-interactions).
        self.claimedRoyalties.set(investor, alreadyClaimed + claimable);

        send(SendParameters{
            to:    investor,
            value: claimable,
            mode:  SendIgnoreErrors,
            body:  "royalty_claim".asComment()
        });
    }

    // ── Refund ────────────────────────────────────────────────────────────────

    receive(msg: Refund) {
        require(self.isLocked && !self.isSuccessful,
            "ToonDrop: refunds only available after a failed raise");

        let investor: Address = sender();
        let invested: Int? = self.investments.get(investor);
        require(invested != null && invested!! > 0,
            "ToonDrop: nothing to refund");

        let refundAmount: Int = invested!!;

        // Clear before sending — prevents re-entrancy.
        self.investments.set(investor, 0);
        self.currentRaise = self.currentRaise - refundAmount;
        self.investorCount = self.investorCount - 1;

        send(SendParameters{
            to:    investor,
            value: refundAmount,
            mode:  SendIgnoreErrors,
            body:  "drop_refund".asComment()
        });
    }

    // ── Stuck-fund recovery ───────────────────────────────────────────────────
    // Recovers TON that cannot be individually claimed (rounding residue,
    // unclaimed investors, etc.).  Only callable by artist after raise locked.

    receive(msg: RecoverStuckFunds) {
        require(sender() == self.artist,
            "ToonDrop: only artist can recover stuck funds");
        require(self.isLocked,
            "ToonDrop: raise must be finalized first");

        let balance: Int = myBalance();
        // Keep a minimal TON balance for storage rent (0.05 TON).
        let safeToWithdraw: Int = balance - ton("0.05");
        require(safeToWithdraw > 0, "ToonDrop: no recoverable balance");

        send(SendParameters{
            to:    msg.recipient,
            value: safeToWithdraw,
            mode:  SendIgnoreErrors,
            body:  "stuck_funds_recovered".asComment()
        });
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    get fun stats(): String {
        let sb: StringBuilder = beginString();
        sb.append("raised: ");    sb.append(self.currentRaise.toString());
        sb.append("/");           sb.append(self.raiseTarget.toString());
        sb.append(" | investors: "); sb.append(self.investorCount.toString());
        sb.append(" | royalties: "); sb.append(self.totalRoyaltiesReceived.toString());
        return sb.toString();
    }

    get fun isSuccessful(): Bool { return self.isSuccessful; }
    get fun isLocked(): Bool     { return self.isLocked;     }
    get fun currentRaise(): Int  { return self.currentRaise; }
    get fun totalRoyalties(): Int{ return self.totalRoyaltiesReceived; }

    // Exact claimable amount for a given investor at the current moment.
    get fun investorClaimable(investor: Address): Int {
        let invested: Int? = self.investments.get(investor);
        if (invested == null || invested!! == 0 || self.currentRaise == 0) {
            return 0;
        }
        let totalShare: Int = (invested!! * self.totalRoyaltiesReceived)
                              / self.currentRaise;
        let prevClaim: Int? = self.claimedRoyalties.get(investor);
        let claimed: Int = prevClaim != null ? prevClaim!! : 0;
        let diff: Int = totalShare - claimed;
        if (diff < self.DUST_THRESHOLD) { return 0; }
        return diff;
    }

    get fun investorTotal(investor: Address): Int {
        let invested: Int? = self.investments.get(investor);
        if (invested == null || self.currentRaise == 0) { return 0; }
        return (invested!! * self.totalRoyaltiesReceived) / self.currentRaise;
    }

    get fun investorClaimed(investor: Address): Int {
        let c: Int? = self.claimedRoyalties.get(investor);
        return c != null ? c!! : 0;
    }
}
