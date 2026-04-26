contract Accumulator {
    total: Int as uint256;

    init() {
        self.total = 0;
    }

    receive(msg: Add) {
        require(msg.amount > 0, "Amount must be positive");
        self.total += msg.amount;
    }

    get fun total(): Int {
        return self.total;
    }
}

message Add {
    amount: Int as uint256;
}