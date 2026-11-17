// SPDX-License-Identifier: UNLICENSED
// Test fixtures for bridge.oft. Minimal stand-ins for LayerZero v2's EndpointV2, an OFT and a
// composer, with the events, packet layout and calls of the public LayerZero v2 contracts
// (https://github.com/LayerZero-Labs/LayerZero-v2: EndpointV2.sol, MessagingComposer.sol,
// PacketV1Codec.sol, OFTCore.sol, OFTMsgCodec.sol, OFTComposeMsgCodec.sol). No fees, no peers,
// no decimals conversion. Bytecode lives in layerzero.ts.
pragma solidity 0.8.30;

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

contract LzEndpointStub {
    event PacketSent(bytes encodedPayload, bytes options, address sendLibrary);
    event ComposeSent(address from, address to, bytes32 guid, uint16 index, bytes message);

    uint32 public eid;
    mapping(bytes32 => bytes32) public composeQueue;

    function setEid(uint32 value) external {
        eid = value;
    }

    function emitPacket(bytes calldata payload) external {
        emit PacketSent(payload, "", address(0));
    }

    function sendCompose(address to, bytes32 guid, uint16 index, bytes calldata message) external {
        composeQueue[keccak256(abi.encode(msg.sender, to, guid, index))] = keccak256(message);
        emit ComposeSent(msg.sender, to, guid, index, message);
    }

    function lzCompose(address from, address to, bytes32 guid, uint16 index, bytes calldata message, bytes calldata extraData)
        external
        payable
    {
        bytes32 key = keccak256(abi.encode(from, to, guid, index));
        require(composeQueue[key] == keccak256(message), "LZ_ComposeNotFound");
        composeQueue[key] = bytes32(uint256(1));
        ComposerStub(to).lzCompose(from, guid, message, msg.sender, extraData);
    }
}

contract OftStub {
    event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD);
    event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD);

    address public endpoint;
    mapping(address => uint256) public balanceOf;

    function setEndpoint(address value) external {
        endpoint = value;
    }

    function send(bytes32 guid, uint64 nonce, uint32 dstEid, bytes32 receiver, bytes32 sendTo, uint64 amount, bytes calldata composeMsg)
        external
    {
        bytes memory message = composeMsg.length == 0
            ? abi.encodePacked(sendTo, amount)
            : abi.encodePacked(sendTo, amount, bytes32(uint256(uint160(msg.sender))), composeMsg);
        bytes memory payload = abi.encodePacked(
            uint8(1), nonce, LzEndpointStub(endpoint).eid(), bytes32(uint256(uint160(address(this)))), dstEid, receiver, guid, message
        );
        LzEndpointStub(endpoint).emitPacket(payload);
        emit OFTSent(guid, dstEid, msg.sender, amount, amount);
    }

    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata) external payable {
        require(msg.sender == endpoint, "OnlyEndpoint");
        address to = address(uint160(uint256(bytes32(message[0:32]))));
        uint256 amount = uint64(bytes8(message[32:40]));
        balanceOf[to] += amount;
        if (message.length > 40) {
            LzEndpointStub(endpoint).sendCompose(
                to, guid, 0, abi.encodePacked(origin.nonce, origin.srcEid, amount, message[40:])
            );
        }
        emit OFTReceived(guid, origin.srcEid, to, amount);
    }
}

contract ComposerStub {
    event Composed(address from, bytes32 guid, bytes message, address executor);

    uint256 public calls;

    function lzCompose(address from, bytes32 guid, bytes calldata message, address executor, bytes calldata) external payable {
        calls += 1;
        emit Composed(from, guid, message, executor);
    }
}
