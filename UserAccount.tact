// ============================================================
// UserAccount.tact
// ============================================================
import "@stdlib/deploy";
import "./Messages.tact";

contract UserAccount with Deployable {
    pool:     Address;
    owner:    Address;
    supplies: map<Address, SupplyPosition>;
    borrows:  map<Address, BorrowPosition>;
    supplyAssets: map<Int, Address>;
    borrowAssets: map<Int, Address>;
    supplyCount:  Int;
    borrowCount:  Int;

    init(pool: Address, owner: Address) {
        self.pool         = pool;
        self.owner        = owner;
        self.supplies     = emptyMap();
        self.borrows      = emptyMap();
        self.supplyAssets = emptyMap();
        self.borrowAssets = emptyMap();
        self.supplyCount  = 0;
        self.borrowCount  = 0;
    }

    fun requirePool() {
        require(sender() == self.pool, "Only LendingPool");
    }

    receive(msg: DepositConfirm) {
        self.requirePool();
        let existing: SupplyPosition? = self.supplies.get(msg.asset);
        if (existing == null) {
            self.supplyAssets.set(self.supplyCount, msg.asset);
            self.supplyCount = self.supplyCount + 1;
            let scaled: Int = msg.amount * RAY / msg.rateIndex;
            self.supplies.set(msg.asset, SupplyPosition{
                scaledBalance: scaled,
                lastIndex:     msg.rateIndex
            });
        } else {
            let pos: SupplyPosition = existing!!;
            let actualBalance: Int = pos.scaledBalance * msg.rateIndex / RAY;
            let newActual: Int     = actualBalance + msg.amount;
            let newScaled: Int     = newActual * RAY / msg.rateIndex;
            self.supplies.set(msg.asset, SupplyPosition{
                scaledBalance: newScaled,
                lastIndex:     msg.rateIndex
            });
        }
    }

    receive(msg: ExecuteBorrow) {
        self.requirePool();
        require(msg.borrower == self.owner, "Wrong owner");
        send(SendParameters{
            to:    self.pool,
            value: ton("0.05"),
            mode:  SendIgnoreErrors,
            bounce: true,
            body:  ExecuteBorrow{
                asset:              msg.asset,
                amount:             msg.amount,
                borrower:           self.owner,
                totalCollateralUSD: self._totalCollateralUSD(),
                totalDebtUSD:       self._totalDebtUSD()
            }.toCell()
        });
    }

    receive(msg: BorrowConfirmed) {
        self.requirePool();
        let existBorrow: BorrowPosition? = self.borrows.get(msg.asset);
        if (existBorrow == null) {
            self.borrowAssets.set(self.borrowCount, msg.asset);
            self.borrowCount = self.borrowCount + 1;
            self.borrows.set(msg.asset, BorrowPosition{
                scaledDebt: msg.amount * RAY / msg.borrowIndex,
                lastIndex:  msg.borrowIndex
            });
        } else {
            let pos: BorrowPosition = existBorrow!!;
            let actualDebt: Int = pos.scaledDebt * msg.borrowIndex / RAY;
            let newDebt: Int    = actualDebt + msg.amount;
            self.borrows.set(msg.asset, BorrowPosition{
                scaledDebt: newDebt * RAY / msg.borrowIndex,
                lastIndex:  msg.borrowIndex
            });
        }
    }

    receive(msg: ExecuteLiquidation) {
        self.requirePool();
        // Simplified liquidation logic
    }

    fun _totalCollateralUSD(): Int { return 0; }
    fun _totalDebtUSD(): Int { return 0; }

    get fun supplyBalance(asset: Address): Int {
        let pos: SupplyPosition? = self.supplies.get(asset);
        if (pos == null) { return 0; }
        let p: SupplyPosition = pos!!;
        return p.scaledBalance * p.lastIndex / RAY;
    }

    get fun debtBalance(asset: Address): Int {
        let pos: BorrowPosition? = self.borrows.get(asset);
        if (pos == null) { return 0; }
        let p: BorrowPosition = pos!!;
        return p.scaledDebt * p.lastIndex / RAY;
    }
}
