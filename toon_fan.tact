import "@stdlib/deploy";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages
// ─────────────────────────────────────────────────────────────────────────────

message SyncParticipation {
    fan: Address;
    tipVolume: Int as coins;
    investmentVolume: Int as coins;
}

message Mint {
    recipient: Address;
    amount: Int as coins;
}

message VoteOnProposal {
    proposalId: Int as uint256;
    support:    Bool;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Structs
// ─────────────────────────────────────────────────────────────────────────────

struct Proposal {
    description: String;
    votesFor:    Int as coins;
    votesAgainst: Int as coins;
    deadline:    Int as uint32;
    executed:    Bool;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToonFan
// ─────────────────────────────────────────────────────────────────────────────

contract ToonFan with Deployable {

    // ── Storage ──────────────────────────────────────────────────────────────

    artist:      Address;
    registry:    Address;
    
    /// fan address → fan power (calculated from tips + investment)
    fanPower: map<Address, Int>;
    totalFanPower: Int as coins;

    /// current active proposals for the artist's community
    proposals: map<Int, Proposal>;
    nextProposalId: Int as uint256;

    // ── Constructor ──────────────────────────────────────────────────────────

    init(artist: Address, registry: Address) {
        self.artist = artist;
        self.registry = registry;
        self.totalFanPower = 0;
        self.nextProposalId = 0;
    }

    // ── Participation Logic ──────────────────────────────────────────────────

    /// Updated by the ToonArtist contract or ToonDrop to sync fan activity.
    receive(msg: SyncParticipation) {
        require(sender() == self.artist, "ToonFan: only artist contract can sync participation");

        let currentPower: Int = 0;
        let existing: Int? = self.fanPower.get(msg.fan);
        if (existing != null) {
            currentPower = existing!!;
        }

        // New fan power = total tip volume + total investment volume (weighted)
        let newPower: Int = msg.tipVolume + msg.investmentVolume;
        
        // Update global total
        self.totalFanPower = self.totalFanPower - currentPower + newPower;
        self.fanPower.set(msg.fan, newPower);

        // In production: trigger $TOON-ARTIST mint for the fan
        send(SendParameters{
            to: self.artist, // Artist contract or owner
            value: 0,
            mode: SendRemainingValue,
            body: Mint{
                recipient: msg.fan,
                amount: newPower * 10 // Ratio for minting
            }.toCell()
        });
    }

    // ── Governance (Artist Level) ───────────────────────────────────────────

    receive("CreateProposal: Change Split Percentage") {
        require(sender() == self.artist, "ToonFan: only artist can create proposals");
        
        let pId: Int = self.nextProposalId;
        self.nextProposalId = self.nextProposalId + 1;

        let p: Proposal = Proposal{
            description: "Change royalty split percentage",
            votesFor: 0,
            votesAgainst: 0,
            deadline: now() + 604800, // 1 week
            executed: false
        };

        self.proposals.set(pId, p);
    }

    receive(msg: VoteOnProposal) {
        let p: Proposal? = self.proposals.get(msg.proposalId);
        require(p != null, "ToonFan: proposal does not exist");
        let proposal: Proposal = p!!;

        require(now() <= proposal.deadline, "ToonFan: voting deadline passed");

        let weight: Int = 0;
        let power: Int? = self.fanPower.get(sender());
        if (power != null) {
            weight = power!!;
        }
        
        require(weight > 0, "ToonFan: no voting weight");

        if (msg.support) {
            proposal.votesFor = proposal.votesFor + weight;
        } else {
            proposal.votesAgainst = proposal.votesAgainst + weight;
        }

        self.proposals.set(msg.proposalId, proposal);
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    get fun getFanPower(fan: Address): Int {
        let power: Int? = self.fanPower.get(fan);
        if (power != null) {
            return power!!;
        }
        return 0;
    }

    get fun isTopFan(fan: Address): Bool {
        let power: Int? = self.fanPower.get(fan);
        if (power != null) {
            // A "top fan" has more than 10% of total fan power
            return power!! * 10 > self.totalFanPower;
        }
        return false;
    }
}
