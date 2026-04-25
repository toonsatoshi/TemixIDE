import "@stdlib/deploy";

struct TrackMetadata {
    title: String;
    uri: String;
    genre: String;
}

contract MusicNft(
    artist: Address,
    metadata: TrackMetadata,
    mintFee: Int as coins,
    reputation: Int as uint32,
) {
    receive() {
        cashback(sender());
    }

    receive("tip") {
        require(context().value >= self.mintFee, "Tip below minimum");
        self.reputation = self.reputation + 1;
        send(SendParameters{
            to: self.artist,
            value: context().value,
            mode: SendIgnoreErrors,
            body: "tip received".asComment()
        });
    }

    get fun reputation(): Int {
        return self.reputation;
    }

    get fun artist(): Address {
        return self.artist;
    }

    get fun metadata(): TrackMetadata {
        return self.metadata;
    }
}
