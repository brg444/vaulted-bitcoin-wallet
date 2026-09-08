import com.sparrowwallet.drongo.OutputDescriptor;
import java.nio.charset.StandardCharsets;
class SparrowNative {
    public static void main(String[] args) throws Exception {
        String descriptor = new String(System.in.readAllBytes(), StandardCharsets.UTF_8).trim();
        try {
            var parsed = OutputDescriptor.getOutputDescriptor(descriptor);
            System.out.println("ACCEPTED " + parsed.toString());
        } catch(Exception error) {
            System.out.println("REJECTED " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }
}
