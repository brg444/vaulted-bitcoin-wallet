import com.sparrowwallet.drongo.ApplicationDir;
import com.sparrowwallet.drongo.BitcoinUnit;
import com.sparrowwallet.drongo.psbt.PSBT;
import com.sparrowwallet.sparrow.control.AddressLabel;
import com.sparrowwallet.sparrow.control.CopyableCoinLabel;
import com.sparrowwallet.sparrow.io.Config;
import com.sparrowwallet.sparrow.transaction.OutputForm;
import com.sparrowwallet.sparrow.transaction.TransactionData;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.Parent;
import javafx.scene.Scene;
import javafx.scene.input.Clipboard;
import javafx.stage.Stage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.imageio.ImageIO;

/** Render the unmodified Sparrow output review with an isolated app home. */
class SparrowReview {
    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("connector-sparrow-");
        System.setProperty(ApplicationDir.getHomeProperty("Sparrow"), directory.toString());
        var psbt = PSBT.fromString(new String(System.in.readAllBytes(), StandardCharsets.US_ASCII).trim(), true);
        var done = new CountDownLatch(1);
        var failure = new AtomicReference<Throwable>();
        Platform.startup(() -> {
            try {
                Config.get().setBitcoinUnit(BitcoinUnit.SATOSHIS);
                var form = new OutputForm(new TransactionData("Savings", psbt), psbt.getPsbtOutputs().getFirst());
                var root = (Parent)form.getContents();
                var stage = new Stage();
                stage.setScene(new Scene(root, 1000, 320));
                stage.show();
                root.applyCss();
                root.layout();
                var label = (AddressLabel)root.lookup("#address");
                var amount = (CopyableCoinLabel)root.lookup("#value");
                var expected = psbt.getTransaction().getOutputs().getFirst();
                if(!label.isVisible() || !label.getText().equals(expected.getScript().getToAddress().toString()) || amount.getValue() != expected.getValue()) {
                    throw new AssertionError("Output review does not match transaction");
                }
                var copy = label.getContextMenu().getItems().stream().filter(item -> item.getText().equals("Copy Address")).findFirst().orElseThrow();
                copy.fire();
                if(!Clipboard.getSystemClipboard().getString().equals(label.getText())) throw new AssertionError("Copied recipient mismatch");
                String artifacts = System.getenv("CONNECTOR_SPARROW_ARTIFACTS");
                if(artifacts != null) {
                    Files.createDirectories(Path.of(artifacts));
                    ImageIO.write(SwingFXUtils.fromFXImage(root.snapshot(null, null), null), "png", Path.of(artifacts, args[2] + ".png").toFile());
                }
                System.out.println("RESULT {\"recipient\":\"" + label.getText() + "\",\"amount\":" + amount.getValue() + "}");
                stage.close();
            } catch(Throwable error) {
                failure.set(error);
            } finally {
                done.countDown();
            }
        });
        if(!done.await(20, TimeUnit.SECONDS)) throw new AssertionError("Sparrow review timed out");
        Platform.exit();
        if(failure.get() != null) throw new AssertionError(failure.get());
    }
}
