# STUN message decoder

## What it answers

What is this STUN message, and if a call is failing, is it this message's fault? Paste the bytes, however you copied
them, and it says what the message is, the address or error it carries and whether its integrity holds, lists what to
fix, and then shows every attribute with the addresses un-XORed and the integrity checks a receiver would run.

## How to use it: an example

Say two peers never connect. You captured the connectivity check Alice sends to a server, and you want to know why the
server ignores it. You know both sides' passwords from their SDPs: Alice's is `alice+password+24+chars` and the
server's is `server+password+24+chars`.

**1. Paste the check and Alice's password.** Press the "ICE connectivity check" sample for the bytes, then replace
the password with `alice+password+24+chars`. Press Run.

```
Message            Binding request
                   0x0001. An ICE connectivity check from "alce" to "srv7" that nominates this pair.
Integrity          MESSAGE-INTEGRITY does not match
                   FINGERPRINT matches.

What to fix, most serious first
Severity  What is wrong                                What to do
Fails     MESSAGE-INTEGRITY: the key tried is the      For an ICE check and its answer, use the
          password itself, a short-term credential     ice-pwd from the SDP of the side that
          as ICE uses.                                 receives the check, not the sender's.
```

In plain words: the bytes arrived intact, since FINGERPRINT passes, but the signature was not made with Alice's
password. That is expected. An ICE check is signed with the password of the side that receives it, so the server can
check it with its own.

**2. Try the receiver's password.** Put `server+password+24+chars` in Password and press Run.

```
Message            Binding request
                   0x0001. An ICE connectivity check from "alce" to "srv7" that nominates this pair.
Integrity          MESSAGE-INTEGRITY and FINGERPRINT match
```

Nothing is left to fix, so the attribute table comes next.

The check is signed correctly. If the server still ignores it, the problem is not this message: look at the server's
own ice-pwd, or at whether the packet reaches it at all.

**3. Read the attribute table for the rest.** USERNAME is `srv7:alce`, the receiver's ufrag first. PRIORITY decodes
to type preference 110, peer-reflexive, which is what a check carries. USE-CANDIDATE means Alice, the controlling
agent, is nominating this pair.

**From Wireshark.** Right-click the packet, choose Copy, then "...as a Hex Dump", and paste. The "Its answer, from
Wireshark" sample is a whole frame copied that way. The offsets and the ASCII column are dropped, and the fields at the
end say `Skipped before it: 42 bytes`, the Ethernet, IPv4 and UDP headers, before the 32-byte STUN message whose
mapped address is 192.0.2.10:54321.

**For TURN.** A TURN request carries USERNAME, REALM and NONCE, and is signed with a long-term key: MD5 of
`username:realm:password`. Enter only the password; the rest comes from the message. A TURN server's success response
repeats neither USERNAME nor REALM, so for one of those, enter them too. The "Long-term credentials" sample is RFC
5769's test vector and verifies with `TheMatrIX`.

## What it reads

- **Any hex**: a hex stream, bytes separated by spaces, colons or commas, `0x` or `\x` prefixes, and dumps with offsets
  and an ASCII column from Wireshark, tcpdump -X, hexdump -C or xxd. A paste from an RFC figure works too: notes after
  a wide gap are ignored. If the bytes start with a captured frame's headers, the STUN message is found by its magic
  cookie and the headers are skipped.
- **The header**: the 14-bit message type split into its method (Binding, Allocate, Refresh and the rest) and its
  class (request, indication, success, error), whose bits are interleaved, which is why a Binding success is 0x0101
  and not 0x0102. Then the length, the magic cookie 0x2112A442 and the 96-bit transaction ID.
- **Addresses**: XOR-MAPPED-ADDRESS, XOR-PEER-ADDRESS and XOR-RELAYED-ADDRESS un-XORed back into the address they
  carry, IPv4 or IPv6, with the XOR shown, plus MAPPED-ADDRESS and ALTERNATE-SERVER sent in the clear.
- **ICE's attributes**: USERNAME split into the receiver's ufrag and the sender's, PRIORITY broken into its type
  preference, local preference and component, USE-CANDIDATE, and the ICE-CONTROLLING or ICE-CONTROLLED tiebreaker.
- **TURN's**: ERROR-CODE, REALM, NONCE, LIFETIME, REQUESTED-TRANSPORT, CHANNEL-NUMBER, PASSWORD-ALGORITHM.
- **The checks**: FINGERPRINT is a CRC-32 of everything before it, XOR 0x5354554E, and is verified on every message.
  MESSAGE-INTEGRITY (HMAC-SHA1) and MESSAGE-INTEGRITY-SHA256 are verified when you give a password. The key is the
  password itself when there is no realm, as for ICE, and MD5 of `username:realm:password` when there is one, or
  SHA-256 when PASSWORD-ALGORITHM asks for it. The password goes through SASLprep first, as RFC 8489 says. The check
  runs in the page; the password goes nowhere.
- **What to fix**: a failed check, an error code with its remedy from RFC 8489 and RFC 8656 (401, 438, 487 and the
  rest), and an ICE check without FINGERPRINT or MESSAGE-INTEGRITY, which RFC 8445 requires.

The samples were made by [aioice](https://github.com/aiortc/aioice), the ICE implementation under aiortc, and by RFC
5769, rather than typed, so they are what real stacks send. Their addresses are from the documentation ranges and their
credentials are made up.

## What it does not read

- **SASLprep's refusals.** The mapping and normalisation that change a password are applied; the rules that reject
  one, for prohibited characters and mixed direction, are not, because a tool checking someone else's message is better
  off trying it.
- **USERHASH** in place of USERNAME. The key needs the username itself, so enter it.
- **Messages without the magic cookie.** The original STUN of RFC 3489 had no cookie; it is refused, not guessed at.
- **TCP framing and TURN ChannelData.** STUN over TCP with RFC 4571's two-byte length, and ChannelData's four-byte
  header, are skipped only as unrecognised bytes before the cookie.
- **Several messages at once.** Paste one message.

## References

- [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489): STUN, including the long-term key and SASLprep
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445): ICE, for USERNAME, PRIORITY, the role attributes, and section
  7.2.4's rule that every check carries FINGERPRINT
- [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656): TURN, and its error codes
- [RFC 5769](https://www.rfc-editor.org/rfc/rfc5769): the test vectors, which the tests check against
