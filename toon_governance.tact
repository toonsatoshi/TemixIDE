import "@stdlib/deploy";
import "./toon_jetton_master.tact";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages — inbound
// ─────────────────────────────────────────────────────────────────────────────

message UnstakeGovernance {
    amount: Int as coins;
}

// Numeric parameter proposals (emissionCap, minWalletAge).
message ProposeParameterUpdate {
    parameter:   String; // "emissionCap" | "minWalletAge"
    newValue:    Int as uint64; // uint64 — wide enough for nanoTOON caps
    description: String;
}

// Address parameter proposals (mintAuthority rotation).
// Kept separate because Addresses cannot be encoded into a uint32.
message ProposeAddressUpdate {
    parameter:   String; // "mintAuthority"
    newAddress:  Address;
    description: String;
}

message VoteOnProposal {
    proposalId: Int as uint256;
    support:    Bool;
}

message VoteOnAddressProposal {
    proposalId: Int as uint256;
    support:    Bool;
}

message ExecuteProposal {
    proposalId: Int as uint256;
}

message ExecuteAddressProposal {
    proposalId: Int as uint256;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Messages — outbound to Vault / Registry
// ─────────────────────────────────────────────────────────────────────────────

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

message UpdateConfigParam {
    parameter: String;
    newValue: Int as uint64;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Structs
// ─────────────────────────────────────────────────────────────────────────────

// Numeric parameter proposal (emissionCap, minWalletAge, etc.)
struct GlobalProposal {
    parameter:    String;
    newValue:     Int as uint64;
    description:  String;
    proposer:     Address;
    votesFor:     Int as coins;
    votesAgainst: Int as coins;
    deadline:     Int as uint32;
    executed:     Bool;
}

// Address parameter proposal (mintAuthority rotation).
struct AddressProposal {
    parameter:    String;
    newAddress:   Address;
    description:  String;
    proposer:     Address;
    votesFor:     Int as coins;
    votesAgainst: Int as coins;
    deadline:     Int as uint32;
    executed:     Bool;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToonGovernance
// ─────────────────────────────────────────────────────────────────────────────
//
//  $TOON holders stake → proportional vote weight.
//  One address gets ONE vote per proposal (dedup via sha256 composite key).
//
//  Execution dispatches TYPED messages to Vault or Registry — no placeholders.
//  Every parameter type maps to a concrete on-chain state change.
//
//  Proposal lifecycle:
//    1. ProposeParameterUpdate / ProposeAddressUpdate  → creates proposal
//    2. VoteOnProposal / VoteOnAddressProposal         → accumulates weight
//    3. ExecuteProposal / ExecuteAddressProposal        → dispatches typed msg
//
contract ToonGovernance with Deployable {

    registry:     Address;
    vault:        Address;
    jettonMaster: Address;

    stakes:      map<Address, Int>;
    totalStaked: Int as coins;

    // Numeric parameter proposals
    proposals:      map<Int, GlobalProposal>;
    nextProposalId: Int as uint256;

    // Address parameter proposals (separate namespace to avoid ID collisions)
    addressProposals:      map<Int, AddressProposal>;
    nextAddressProposalId: Int as uint256;

    // Composite vote dedup: sha256(proposalId + ":" + voterAddress) → Bool
    // Separate maps per proposal family to prevent cross-family vote reuse.
    hasVoted:        map<Int, Bool>;
    hasVotedAddress: map<Int, Bool>;

    // Stake lock: Voter cannot unstake until the latest deadline they voted on.
    lockUntil:       map<Address, Int as uint32>;

    init(registry: Address, vault: Address, jettonMaster: Address) {
        self.registry              = registry;
        self.vault                 = vault;
        self.jettonMaster          = jettonMaster;
        self.totalStaked           = 0;
        self.nextProposalId        = 0;
        self.nextAddressProposalId = 0;
    }

    // ─────────────────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────────────────

    fun voteKey(proposalId: Int, voter: Address): Int {
        let sb: StringBuilder = beginString();
        sb.append(proposalId.toString());
        sb.append(":");
        sb.append(voter.toString());
        return sha256(sb.toString());
    }

    // Quorum = proposer must hold stake; FOR votes must exceed 25% of total staked.
    fun quorumPassed(proposal: GlobalProposal): Bool {
        return proposal.votesFor > proposal.votesAgainst
            && proposal.votesFor > (self.totalStaked / 4);
    }

    fun quorumPassedAddr(proposal: AddressProposal): Bool {
        return proposal.votesFor > proposal.votesAgainst
            && proposal.votesFor > (self.totalStaked / 4);
    }

    // ─────────────────────────────────────────────────────────
    //  Staking (TEP-74 compliant)
    // ─────────────────────────────────────────────────────────

    receive(msg: TokenNotification) {
        // Verify sender is the ToonGovernance's own Jetton wallet
        let expectedWallet: Address = contractAddress(initOf ToonJettonWallet(0, myAddress(), self.jettonMaster));
        require(sender() == expectedWallet, "ToonGovernance: unauthorized Jetton notification");

        let existing: Int? = self.stakes.get(msg.from);
        let current: Int   = existing != null ? existing!! : 0;
        self.stakes.set(msg.from, current + msg.amount);
        self.totalStaked = self.totalStaked + msg.amount;
    }

    receive(msg: UnstakeGovernance) {
        let existing: Int? = self.stakes.get(sender());
        require(existing != null && existing!! >= msg.amount,
            "ToonGovernance: insufficient stake");

        let lock: Int? = self.lockUntil.get(sender());
        if (lock != null) {
            require(now() > lock!!, "ToonGovernance: stake is locked due to active votes");
        }

        let newBal: Int = existing!! - msg.amount;
        self.stakes.set(sender(), newBal);
        self.totalStaked = self.totalStaked - msg.amount;

        // Send Jettons back to the user
        let jettonWallet: Address = contractAddress(initOf ToonJettonWallet(0, myAddress(), self.jettonMaster));
        send(SendParameters{
            to:    jettonWallet,
            value: 0,
            mode:  SendRemainingValue,
            body:  TokenTransfer{
                queryId:              0,
                amount:               msg.amount,
                destination:          sender(),
                response_destination: sender(),
                customPayload:        null,
                forward_ton_amount:   0,
                forward_payload:      emptySlice()
            }.toCell()
        });
    }

    // ─────────────────────────────────────────────────────────
    //  Numeric parameter proposals (emissionCap, minWalletAge)
    // ─────────────────────────────────────────────────────────

    receive(msg: ProposeParameterUpdate) {
        let weight: Int? = self.stakes.get(sender());
        require(weight != null && weight!! > 0,
            "ToonGovernance: must stake to propose");

        // Whitelist prevents governance spam for unknown parameters.
        require(
            msg.parameter == "emissionCap" ||
            msg.parameter == "minWalletAge",
            "ToonGovernance: unknown numeric parameter"
        );

        let pId: Int = self.nextProposalId;
        self.nextProposalId = self.nextProposalId + 1;

        self.proposals.set(pId, GlobalProposal{
            parameter:    msg.parameter,
            newValue:     msg.newValue,
            description:  msg.description,
            proposer:     sender(),
            votesFor:     0,
            votesAgainst: 0,
            deadline:     now() + 1209600, // 2-week voting window
            executed:     false
        });
    }

    receive(msg: VoteOnProposal) {
        let p: GlobalProposal? = self.proposals.get(msg.proposalId);
        require(p != null, "ToonGovernance: proposal does not exist");
        let proposal: GlobalProposal = p!!;

        require(now() <= proposal.deadline, "ToonGovernance: voting closed");
        require(!proposal.executed,        "ToonGovernance: already executed");

        let weight: Int? = self.stakes.get(sender());
        require(weight != null && weight!! > 0,
            "ToonGovernance: no voting weight");

        let key: Int = self.voteKey(msg.proposalId, sender());
        require(self.hasVoted.get(key) == null,
            "ToonGovernance: already voted on this proposal");

        self.hasVoted.set(key, true);
        
        // Update lock: voter is locked until the latest deadline among their votes
        let currentLock: Int? = self.lockUntil.get(sender());
        if (currentLock == null || proposal.deadline > currentLock!!) {
            self.lockUntil.set(sender(), proposal.deadline);
        }

        if (msg.support) {
            proposal.votesFor     = proposal.votesFor     + weight!!;
        } else {
            proposal.votesAgainst = proposal.votesAgainst + weight!!;
        }

        self.proposals.set(msg.proposalId, proposal);
    }

    // Execute: dispatches a deterministic typed message to Registry.
    receive(msg: ExecuteProposal) {
        // Governance should now target Registry for config updates.
        // However, the Registry handles a full Configuration struct.
        // We'll need a way to update individual parameters or just send the full config.
        // For now, I'll follow the principle of centralizing in the Registry.

        let p: GlobalProposal? = self.proposals.get(msg.proposalId);
        require(p != null, "ToonGovernance: proposal does not exist");
        let proposal: GlobalProposal = p!!;

        require(now() > proposal.deadline,     "ToonGovernance: voting still open");
        require(!proposal.executed,            "ToonGovernance: already executed");
        require(self.quorumPassed(proposal),   "ToonGovernance: quorum not met");

        proposal.executed = true;
        self.proposals.set(msg.proposalId, proposal);

        // Implementation of individual parameter updates in Registry.
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            body: UpdateConfigParam{
                parameter: proposal.parameter,
                newValue: proposal.newValue
            }.toCell()
        });
    }

    // ─────────────────────────────────────────────────────────
    //  Address parameter proposals (mintAuthority rotation)
    // ─────────────────────────────────────────────────────────

    receive(msg: ProposeAddressUpdate) {
        let weight: Int? = self.stakes.get(sender());
        require(weight != null && weight!! > 0,
            "ToonGovernance: must stake to propose");

        require(
            msg.parameter == "mintAuthority",
            "ToonGovernance: unknown address parameter"
        );

        let pId: Int = self.nextAddressProposalId;
        self.nextAddressProposalId = self.nextAddressProposalId + 1;

        self.addressProposals.set(pId, AddressProposal{
            parameter:    msg.parameter,
            newAddress:   msg.newAddress,
            description:  msg.description,
            proposer:     sender(),
            votesFor:     0,
            votesAgainst: 0,
            deadline:     now() + 1209600,
            executed:     false
        });
    }

    receive(msg: VoteOnAddressProposal) {
        let p: AddressProposal? = self.addressProposals.get(msg.proposalId);
        require(p != null, "ToonGovernance: address proposal does not exist");
        let proposal: AddressProposal = p!!;

        require(now() <= proposal.deadline, "ToonGovernance: voting closed");
        require(!proposal.executed,        "ToonGovernance: already executed");

        let weight: Int? = self.stakes.get(sender());
        require(weight != null && weight!! > 0,
            "ToonGovernance: no voting weight");

        let key: Int = self.voteKey(msg.proposalId, sender());
        require(self.hasVotedAddress.get(key) == null,
            "ToonGovernance: already voted on this proposal");

        self.hasVotedAddress.set(key, true);

        // Update lock
        let currentLock: Int? = self.lockUntil.get(sender());
        if (currentLock == null || proposal.deadline > currentLock!!) {
            self.lockUntil.set(sender(), proposal.deadline);
        }

        if (msg.support) {
            proposal.votesFor     = proposal.votesFor     + weight!!;
        } else {
            proposal.votesAgainst = proposal.votesAgainst + weight!!;
        }

        self.addressProposals.set(msg.proposalId, proposal);
    }

    receive(msg: ExecuteAddressProposal) {
        let p: AddressProposal? = self.addressProposals.get(msg.proposalId);
        require(p != null, "ToonGovernance: address proposal does not exist");
        let proposal: AddressProposal = p!!;

        require(now() > proposal.deadline,         "ToonGovernance: voting still open");
        require(!proposal.executed,                "ToonGovernance: already executed");
        require(self.quorumPassedAddr(proposal),   "ToonGovernance: quorum not met");

        proposal.executed = true;
        self.addressProposals.set(msg.proposalId, proposal);

        if (proposal.parameter == "mintAuthority") {
            // → registry.UpdateMintAuthority — typed cross-contract call
            send(SendParameters{
                to:   self.registry,
                value: 0,
                mode:  SendRemainingValue,
                body:  UpdateMintAuthority{
                    newAuthority: proposal.newAddress
                }.toCell()
            });
        }
    }

    // ─────────────────────────────────────────────────────────
    //  Getters
    // ─────────────────────────────────────────────────────────

    get fun totalStaked(): Int { return self.totalStaked; }

    get fun stake(voter: Address): Int {
        let s: Int? = self.stakes.get(voter);
        return s != null ? s!! : 0;
    }

    get fun getProposal(proposalId: Int): GlobalProposal? {
        return self.proposals.get(proposalId);
    }

    get fun getAddressProposal(proposalId: Int): AddressProposal? {
        return self.addressProposals.get(proposalId);
    }

    get fun hasAddressVoted(proposalId: Int, voter: Address): Bool {
        let key: Int = self.voteKey(proposalId, voter);
        return self.hasVoted.get(key) != null;
    }

    get fun hasAddressVotedOnAddressProposal(proposalId: Int, voter: Address): Bool {
        let key: Int = self.voteKey(proposalId, voter);
        return self.hasVotedAddress.get(key) != null;
    }

    get fun quorumMet(proposalId: Int): Bool {
        let p: GlobalProposal? = self.proposals.get(proposalId);
        if (p == null) { return false; }
        return self.quorumPassed(p!!);
    }
}
