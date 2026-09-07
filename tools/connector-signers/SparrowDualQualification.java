import com.sparrowwallet.drongo.policy.Policy;
import com.sparrowwallet.drongo.policy.PolicyType;
import com.sparrowwallet.drongo.protocol.ScriptType;
import com.sparrowwallet.drongo.psbt.PSBT;
import com.sparrowwallet.drongo.wallet.*;
import java.nio.charset.StandardCharsets;

/** Public fixture only; runs the software signing operations used by Sparrow. */
class SparrowDualQualification {
    public static void main(String[] args) throws Exception {
        ScriptType type = args[0].equals("p2tr") ? ScriptType.P2TR : ScriptType.P2WPKH;
        var seed = new DeterministicSeed("absent essay fox snake vast pumpkin height crouch silent bulb excuse razor", "pp", 0, DeterministicSeed.Type.BIP39);
        var wallet = new Wallet();
        wallet.setPolicyType(PolicyType.SINGLE_HD);
        wallet.setScriptType(type);
        var store = Keystore.fromSeed(seed, PolicyType.SINGLE_HD, type.getDefaultDerivation());
        wallet.getKeystores().add(store);
        wallet.setDefaultPolicy(Policy.getPolicy(PolicyType.SINGLE_HD, type, wallet.getKeystores(), 1));
        if(!wallet.isValid()) throw new AssertionError("Invalid fixture wallet");
        var psbt = PSBT.fromString(new String(System.in.readAllBytes(), StandardCharsets.US_ASCII).trim(), true);
        // AppController offers Yes/No for this warning. Model explicit Yes,
        // while requiring both requested modes to be exactly SINGLE.
        for(int i = 0; i < 2; i++) {
            if(psbt.getPsbtInputs().get(i).getSigHash() != com.sparrowwallet.drongo.protocol.SigHash.SINGLE)
                throw new AssertionError("Expected SINGLE");
        }
        try {
            psbt.verifySigHashes();
            throw new AssertionError("Expected non-default sighash warning");
        } catch(com.sparrowwallet.drongo.psbt.PSBTSignatureException warning) {
            if(!warning.getMessage().contains("requests SIGHASH_SINGLE.")) throw warning;
        }
        var before = psbt.getTransaction().bitcoinSerialize();
        var nodes = wallet.getSigningNodes(psbt);
        if(!wallet.canSign(psbt) || nodes.size() != 2 ||
            !nodes.containsKey(psbt.getPsbtInputs().get(0)) || !nodes.containsKey(psbt.getPsbtInputs().get(1))) {
            throw new AssertionError("Must recognize both reserves and exclude Savings");
        }
        wallet.computeSilentPaymentOutputs(psbt, nodes);
        wallet.sign(nodes);
        psbt.verifySignatures();
        if(!psbt.getPsbtInputs().get(0).isSigned() || !psbt.getPsbtInputs().get(1).isSigned() ||
            psbt.getPsbtInputs().get(2).isSigned()) throw new AssertionError("Wrong signed inputs");
        if(!java.util.Arrays.equals(before, psbt.getTransaction().bitcoinSerialize())) throw new AssertionError("Transaction changed");
        System.out.println("RESULT " + psbt.toBase64String());
    }
}
