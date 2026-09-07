import com.sparrowwallet.drongo.KeyPurpose;
import com.sparrowwallet.drongo.Utils;
import com.sparrowwallet.drongo.policy.Policy;
import com.sparrowwallet.drongo.policy.PolicyType;
import com.sparrowwallet.drongo.protocol.ScriptType;
import com.sparrowwallet.drongo.psbt.PSBT;
import com.sparrowwallet.drongo.wallet.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Public disposable BIP39 fixture; no user wallet, network, or secret input. */
class SparrowQualification {
    public static void main(String[] args) throws Exception {
        ScriptType type = args[1].equals("p2tr") ? ScriptType.P2TR : ScriptType.P2WPKH;
        // Public seed from Sparrow/Drongo's WalletTest, with its test passphrase.
        var seed = new DeterministicSeed("absent essay fox snake vast pumpkin height crouch silent bulb excuse razor", "pp", 0, DeterministicSeed.Type.BIP39);
        var wallet = new Wallet();
        wallet.setPolicyType(PolicyType.SINGLE_HD);
        wallet.setScriptType(type);
        var store = Keystore.fromSeed(seed, PolicyType.SINGLE_HD, type.getDefaultDerivation());
        wallet.getKeystores().add(store);
        wallet.setDefaultPolicy(Policy.getPolicy(PolicyType.SINGLE_HD, type, wallet.getKeystores(), 1));
        if(!wallet.isValid()) throw new AssertionError("Invalid software wallet");
        if(args[0].equals("key")) {
            var node = new WalletNode(wallet, KeyPurpose.RECEIVE, 0);
            System.out.println("RESULT {\"publicKey\":\"" + Utils.bytesToHex(node.getPubKey().getPubKey()) + "\",\"fingerprint\":\"" + store.getKeyDerivation().getMasterFingerprint() + "\"}");
            return;
        }
        var psbt = PSBT.fromString(new String(System.in.readAllBytes(), StandardCharsets.US_ASCII).trim(), true);
        psbt.verifySigHashes();
        var foreign = psbt.getPsbtInputs().getFirst();
        if(!foreign.isFinalized()) throw new AssertionError("Savings input not finalized");
        var witness = foreign.getFinalScriptWitness().toByteArray();
        var nodes = wallet.getSigningNodes(psbt);
        if(!wallet.canSign(psbt) || nodes.size() != 1 || !nodes.containsKey(psbt.getPsbtInputs().get(1))) {
            throw new AssertionError("Wallet must recognize only its connector input");
        }
        // Same operations used by HeadersController.signUnencryptedKeystores.
        wallet.computeSilentPaymentOutputs(psbt, nodes);
        wallet.sign(nodes);
        psbt.verifySignatures();
        if(!psbt.isSigned()) throw new AssertionError("PSBT not fully signed");
        wallet.finalise(psbt);
        if(!psbt.isFinalized() || !Arrays.equals(witness, foreign.getFinalScriptWitness().toByteArray())) {
            throw new AssertionError("Finalization changed Savings input");
        }
        var recipient = psbt.getTransaction().getOutputs().getFirst();
        var address = recipient.getScript().getToAddress(); // OutputController uses this exact conversion.
        System.out.println("RESULT {\"tx\":\"" + Utils.bytesToHex(psbt.extractTransaction().bitcoinSerialize()) + "\",\"psbt\":\"" + psbt.toBase64String() + "\",\"recipient\":\"" + address + "\",\"amount\":" + recipient.getValue() + ",\"fee\":" + psbt.getFee() + "}");
    }
}
