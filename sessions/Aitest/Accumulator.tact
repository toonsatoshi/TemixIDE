message Add {
    value: Int as uint128;
}

contract Accumulator {
    total: Int as uint128;

    init() {
        self.total = 0;
    }

    receive(msg: Add) {
        self.total += msg.value;
    }

    get fun getTotal(): Int {
        return self.total;
    }
}