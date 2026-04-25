import "@stdlib/deploy";

// ── TEP-64 / TEP-74 Jetton standard structs ──────────────────────────────────

struct JettonData {
    totalSupply:  Int;
    mintable:     Bool;
    adminAddress: Address;
    content:      Cell;
    walletCode:   Cell;
}

// ── Messages ──────────────────────────────────────────────────────────────────

message(0xf8a7ea5) TokenTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    response_destination: Address?;
    customPayload: Cell?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x1674b0a0) TokenMint {
    queryId: Int as uint64;
    amount: Int as coins;
    receiver: Address;
}

message(0x178d4519) TokenTransferInternal {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;
    response_destination: Address?;
    forward_ton_amount: Int as coins;
    forward_payload: Slice as remaining;
}

message(0x7362d09c) TokenNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    from: Address;
    forward_payload: Slice as remaining;
}

message(0x595f07bc) TokenBurn {
    queryId: Int as uint64;
    amount: Int as coins;
    response_destination: Address?;
}

message(0x7bdd97de) TokenBurnNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    owner: Address;
    response_destination: Address?;
}

message(0xd53276db) TokenExcesses {
    queryId: Int as uint64;
}

message UpdateMintAuthority {
    newAuthority: Address;
}

message UpdateMetadata {
    newUri: String;
}

// ── ToonJettonMaster ──────────────────────────────────────────────────────────

contract ToonJettonMaster(
    owner:         Address,
    mintAuthority: Address,
    totalSupply:   Int as coins,
    metadataUri:   String,
) with Deployable {

    receive(msg: TokenMint) {
        require(sender() == self.mintAuthority, "Only ToonVault can mint");
        self.totalSupply = self.totalSupply + msg.amount;
        
        // Proper Jetton minting: deploy/notify the recipient's wallet
        let init: StateInit = initOf ToonJettonWallet(0, msg.receiver, myAddress());
        send(SendParameters{
            to: contractAddress(init),
            value: 0,
            mode: SendRemainingValue,
            bounce: false,
            body: TokenTransferInternal{
                queryId: msg.queryId,
                amount: msg.amount,
                from: myAddress(),
                response_destination: msg.receiver,
                forward_ton_amount: 0,
                forward_payload: emptySlice()
            }.toCell(),
            code: init.code,
            data: init.data
        });
    }

    receive(msg: TokenBurnNotification) {
        // Only the master's own wallets can send this
        let expectedWallet: Address = contractAddress(initOf ToonJettonWallet(0, msg.owner, myAddress()));
        require(sender() == expectedWallet, "Unauthorized burn notification");
        
        self.totalSupply = self.totalSupply - msg.amount;
        if (msg.response_destination != null) {
            send(SendParameters{
                to:    msg.response_destination!!,
                value: 0,
                mode:  SendRemainingValue,
                body:  TokenExcesses{ queryId: msg.queryId }.toCell()
            });
        }
    }

    // Rotate mint authority to ToonVault after deploy
    receive(msg: UpdateMintAuthority) {
        require(sender() == self.owner, "Not owner");
        self.mintAuthority = msg.newAuthority;
    }

    // Update metadata URI (e.g. after IPFS pinning)
    receive(msg: UpdateMetadata) {
        require(sender() == self.owner, "Not owner");
        self.metadataUri = msg.newUri;
    }

    // TEP-64 off-chain metadata getter — Tonkeeper reads this
    // Content cell: byte 0x01 = off-chain URL, then snake-encoded URI
    get fun get_jetton_data(): JettonData {
        let content: Cell = beginCell()
            .storeUint(1, 8)
            .storeSlice(self.metadataUri.asSlice())
            .endCell();

        return JettonData{
            totalSupply:  self.totalSupply,
            mintable:     true,
            adminAddress: self.owner,
            content:      content,
            walletCode:   initOf ToonJettonWallet(0, myAddress(), myAddress()).code
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        let init: StateInit = initOf ToonJettonWallet(0, owner, myAddress());
        return contractAddress(init);
    }

    get fun totalSupply(): Int       { return self.totalSupply; }
    get fun owner(): Address         { return self.owner; }
    get fun mintAuthority(): Address { return self.mintAuthority; }
    get fun metadataUri(): String    { return self.metadataUri; }
}

// ── ToonJettonWallet ──────────────────────────────────────────────────────────

contract ToonJettonWallet(
    balance: Int as coins,
    owner:   Address,
    master:  Address,
) {
    receive(msg: TokenTransfer) {
        require(sender() == self.owner, "Not owner");
        require(self.balance >= msg.amount, "Insufficient balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to:     msg.destination,
            value:  msg.forward_ton_amount,
            bounce: false,
            mode:   SendRemainingValue,
            body:   TokenTransferInternal{
                queryId:              msg.queryId,
                amount:               msg.amount,
                from:                 self.owner,
                response_destination: msg.response_destination,
                forward_ton_amount:   msg.forward_ton_amount,
                forward_payload:      msg.forward_payload
            }.toCell()
        });
    }

    receive(msg: TokenTransferInternal) {
        let ctx: Context = context();
        if (ctx.sender != self.master) {
            let init: StateInit = initOf ToonJettonWallet(0, msg.from, self.master);
            require(ctx.sender == contractAddress(init), "Invalid sender");
        }

        self.balance = self.balance + msg.amount;

        if (msg.forward_ton_amount > 0) {
            send(SendParameters{
                to: self.owner,
                value: msg.forward_ton_amount,
                mode: SendPayGasSeparately,
                bounce: false,
                body: TokenNotification{
                    queryId: msg.queryId,
                    amount: msg.amount,
                    from: msg.from,
                    forward_payload: msg.forward_payload
                }.toCell()
            });
        }

        if (msg.response_destination != null) {
            send(SendParameters{
                to: msg.response_destination!!,
                value: 0,
                mode: SendRemainingValue,
                bounce: false,
                body: TokenExcesses{ queryId: msg.queryId }.toCell()
            });
        }
    }

    receive(msg: TokenBurn) {
        require(sender() == self.owner, "Not owner");
        require(self.balance >= msg.amount, "Insufficient balance");
        self.balance = self.balance - msg.amount;
        send(SendParameters{
            to:    self.master,
            value: 0,
            mode:  SendRemainingValue,
            body:  TokenBurnNotification{
                queryId:              msg.queryId,
                amount:               msg.amount,
                owner:                self.owner,
                response_destination: msg.response_destination
            }.toCell()
        });
    }

    get fun balance(): Int   { return self.balance; }
    get fun owner(): Address { return self.owner; }
}
