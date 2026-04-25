import "@stdlib/deploy";
import "./toon_jetton_master.tact";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages
// ─────────────────────────────────────────────────────────────────────────────

message RegisterArtist {
    artistContract: Address;
}

message StageArtistRegistration {
    artistContract: Address;
    wallet: Address;
}

message ConfirmArtistRegistration {
    wallet: Address;
}

message ArtistRegistrationConfirmed {
    wallet: Address;
}

message StageTrackRegistration {
    trackId:        Int as uint256;
    fingerprint:    Int as uint256;
    trackContract:  Address;
}

message ConfirmTrackRegistration {
    trackId: Int as uint256;
}

message TrackStagingAccepted {
    trackId: Int as uint256;
}

message TrackRegistrationFinalized {
    trackId: Int as uint256;
    trackContract: Address;
}

message UnstakeToon {
    amount: Int as coins;
}

message AddTrack {
    trackId:     Int as uint256;
    fingerprint: Int as uint256;
    trackContract: Address;
}

struct ArtistDetails {
    reputation: Int as uint32;
    totalTipVolume: Int as coins;
    stakedToon: Int as coins;
    isActive: Bool;
    totalTracks: Int as uint32;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToonArtist
// ─────────────────────────────────────────────────────────────────────────────
//
//  Status: IMPLEMENTED (Artist Identity & Reputation)
//
contract ToonArtist with Deployable {

    owner:          Address;
    registry:       Address;
    jettonMaster:   Address;
    telegramHash:   Int as uint256;
    metadataUri:    String;

    reputation:     Int as uint32;
    totalTipVolume: Int as coins;
    stakedToon:     Int as coins;

    tracks:      map<Int, Address>;
    totalTracks: Int as uint32;

    pendingTracks: map<Int, Address>; // trackId -> trackContract (for 2PC)

    isRegistered: Bool; // Two-phase commit status

    const MIN_STAKE:            Int = 100000000000; // 100 $TOON (9 decimals)
    const TOON_DROP_THRESHOLD:  Int = 1000;

    init(owner: Address, registry: Address, jettonMaster: Address, telegramHash: Int, metadataUri: String) {
        self.owner         = owner;
        self.registry      = registry;
        self.jettonMaster  = jettonMaster;
        self.telegramHash  = telegramHash;
        self.metadataUri   = metadataUri;
        self.reputation    = 0;
        self.totalTipVolume = 0;
        self.stakedToon    = 0;
        self.totalTracks   = 0;
        self.isRegistered  = false;
    }

    receive(msg: UpdateMetadata) {
        require(sender() == self.owner, "ToonArtist: only owner can update metadata");
        require(msg.newUri != "", "ToonArtist: empty metadata URI");
        self.metadataUri = msg.newUri;
    }

    receive() {
        self.totalTipVolume = self.totalTipVolume + context().value;
    }

    receive("Tip received") {
        self.totalTipVolume = self.totalTipVolume + context().value;
    }

    receive(msg: TokenNotification) {
        // Verify sender is the ToonArtist's own Jetton wallet
        let expectedWallet: Address = contractAddress(initOf ToonJettonWallet(0, myAddress(), self.jettonMaster));
        require(sender() == expectedWallet, "ToonArtist: unauthorized Jetton notification");

        // Staking is owner-only for artist identity
        require(msg.from == self.owner, "ToonArtist: only owner can stake");

        self.stakedToon = self.stakedToon + msg.amount;
    }

    receive(msg: UnstakeToon) {
        require(sender() == self.owner, "ToonArtist: only owner can unstake");
        require(self.stakedToon >= msg.amount, "ToonArtist: insufficient stake");

        self.stakedToon = self.stakedToon - msg.amount;

        // Send Jettons back to the owner
        let jettonWallet: Address = contractAddress(initOf ToonJettonWallet(0, myAddress(), self.jettonMaster));
        send(SendParameters{
            to:    jettonWallet,
            value: 0,
            mode:  SendRemainingValue,
            body:  TokenTransfer{
                queryId:              0,
                amount:               msg.amount,
                destination:          self.owner,
                response_destination: self.owner,
                customPayload:        null,
                forward_ton_amount:   0,
                forward_payload:      emptySlice()
            }.toCell()
        });
    }

    // 2PC Registration handler
    receive("RegisterSelf") {
        require(sender() == self.owner, "ToonArtist: only owner can initiate registration");
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            body: StageArtistRegistration{
                artistContract: myAddress(),
                wallet: self.owner
            }.toCell()
        });
    }

    receive("StagingAccepted") {
        require(sender() == self.registry, "ToonArtist: unauthorized staging callback");
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            body: ConfirmArtistRegistration{ wallet: self.owner }.toCell()
        });
    }

    receive(msg: TrackStagingAccepted) {
        require(sender() == self.registry, "ToonArtist: unauthorized staging callback");
        let trackContract: Address? = self.pendingTracks.get(msg.trackId);
        require(trackContract != null, "ToonArtist: no pending track found for confirmation");

        // Now that Registry has staged, tell the Track contract to confirm
        send(SendParameters{
            to: trackContract!!,
            value: 0,
            mode: SendRemainingValue,
            body: "ConfirmRegistration".asComment()
        });

        // Cleanup pending
        self.pendingTracks.set(msg.trackId, null);
    }

    receive("ConfirmRegistration") {
        require(sender() == self.owner, "ToonArtist: only owner can confirm registration");
        send(SendParameters{
            to: self.registry,
            value: 0,
            mode: SendRemainingValue,
            body: ConfirmArtistRegistration{ wallet: self.owner }.toCell()
        });
    }

    receive(msg: ArtistRegistrationConfirmed) {
        require(sender() == self.registry, "ToonArtist: unauthorized confirmation callback");
        require(msg.wallet == self.owner, "ToonArtist: wallet mismatch in confirmation");
        self.isRegistered = true;
    }

    // Add a track to this artist's on-chain catalog.
    // First track: free — this is how identity is bootstrapped.
    // Subsequent tracks: require MIN_STAKE to prevent spam.
    receive(msg: AddTrack) {
        require(sender() == self.owner, "ToonArtist: only owner can add tracks");
        require(msg.trackContract != newAddress(0, 0), "ToonArtist: invalid track contract address");

        if (self.totalTracks > 0) {
            require(self.isActive(), "ToonArtist: stake required for additional tracks");
        }

        // Store pending track contract to notify later
        self.pendingTracks.set(msg.trackId, msg.trackContract);

        // Initiate staging in Registry
        send(SendParameters{
            to:    self.registry,
            value: 0,
            mode:  SendRemainingValue,
            body:  StageTrackRegistration{
                trackId:       msg.trackId,
                fingerprint:   msg.fingerprint,
                trackContract: msg.trackContract
            }.toCell()
        });
    }

    receive(msg: TrackRegistrationFinalized) {
        // This comes from the ToonTrack contract after 2PC completes in Registry
        
        // Verification: ensure the sender is the same contract we pended
        let pending: Address? = self.pendingTracks.get(msg.trackId);
        require(pending != null, "ToonArtist: track not pending");
        require(sender() == pending!!, "ToonArtist: invalid track sender");
        
        // Ensure this track wasn't already added
        if (self.tracks.get(msg.trackId) == null) {
            self.tracks.set(msg.trackId, msg.trackContract);
            self.totalTracks   = self.totalTracks + 1;
            self.reputation    = self.reputation + 10;
            // Clear pending
            self.pendingTracks.set(msg.trackId, null);
        }
    }

    get fun isActive(): Bool {
        return self.stakedToon >= self.MIN_STAKE;
    }

    get fun canLaunchToonDrop(): Bool {
        return self.reputation >= self.TOON_DROP_THRESHOLD;
    }

    get fun getDetails(): ArtistDetails {
        return ArtistDetails{
            reputation: self.reputation,
            totalTipVolume: self.totalTipVolume,
            stakedToon: self.stakedToon,
            isActive: self.isActive(),
            totalTracks: self.totalTracks
        };
    }

    get fun isRegistered(): Bool { return self.isRegistered; }
    get fun getTrack(trackId: Int): Address? { return self.tracks.get(trackId); }
    get fun reputation(): Int                { return self.reputation; }
    get fun owner(): Address                 { return self.owner; }
    get fun totalTracks(): Int               { return self.totalTracks; }
    get fun stakedToon(): Int                { return self.stakedToon; }
}
