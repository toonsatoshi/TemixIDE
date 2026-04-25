import "@stdlib/deploy";

message Increment {
    amount: Int as uint32;
}

message Reset {}

contract Counter with Deployable {
    count: Int as uint64;

    init() {
        self.count = 0;
    }

    receive(msg: Increment) {
        self.count = self.count + msg.amount;
    }

    receive(msg: Reset) {
        self.count = 0;
    }

    get fun count(): Int {
        return self.count;
    }

    get fun doubled(): Int {
        return self.count * 2;
    }
}
