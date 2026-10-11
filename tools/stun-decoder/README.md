## What it reads

- **The header**: the 14-bit message type split into its method (Binding, Allocate, Refresh and the rest) and its
  class (request, indication, success, error), whose bits are interleaved, which is why a Binding success is 0x0101
  and not 0x0102. Then the length, the magic cookie 0x2112A442 and the 96-bit transaction ID.
- **Addresses**: XOR-MAPPED-ADDRESS, XOR-PEER-ADDRESS and XOR-RELAYED-ADDRESS un-XORed back into the address they
  carry, IPv4 or IPv6, with the XOR shown, plus the older MAPPED-ADDRESS sent in the clear.
- **ICE's attributes**: USERNAME split into the receiver's ufrag and the sender's, PRIORITY broken into its type
  preference, local preference and component, USE-CANDIDATE, and the ICE-CONTROLLING or ICE-CONTROLLED tiebreaker.
- **TURN's**: ERROR-CODE, REALM, NONCE, LIFETIME, REQUESTED-TRANSPORT, CHANNEL-NUMBER.
- **The checks**: FINGERPRINT is a CRC-32 of everything before it, XOR 0x5354554E, and is verified on every message.
  MESSAGE-INTEGRITY is an HMAC-SHA1 keyed with the password, so it is verified when you give one. The check runs in
  the page; the password goes nowhere.

The samples were made by [aioice](https://github.com/aiortc/aioice), the ICE implementation under aiortc, rather than
typed, so they are what a real ICE stack sends. Their addresses are from the documentation ranges and their
credentials are made up.

## What it does not read

- **MESSAGE-INTEGRITY-SHA256 and long-term credentials.** The SHA-256 variant and TURN's long-term key, an MD5 of
  username, realm and password, are shown but not checked.
- **Messages without the magic cookie.** The original STUN of RFC 3489 had no cookie; it is refused, not guessed at.
- **Several messages at once.** Paste one message.

## References

- [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489): STUN
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445): ICE, for USERNAME, PRIORITY and the role attributes
- [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656): TURN
