import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.IndexReader;
import org.apache.lucene.store.FSDirectory;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.IndexableField;
import java.nio.file.Paths;

public class DumpEclipse {
    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: java -cp ... DumpEclipse <path-to-unpacked-index>");
            System.exit(1);
        }

        System.err.println("Opening Lucene index at: " + args[0]);
        FSDirectory dir = FSDirectory.open(Paths.get(args[0]));
        IndexReader reader = DirectoryReader.open(dir);

        int total = reader.maxDoc();
        System.err.println("Total documents to scan: " + total);

        for (int i = 0; i < total; i++) {
            Document doc = reader.document(i);

            // Debug: Print fields of the first document to verify structure
            if (i == 0) {
                System.err.println("--- DEBUG: Fields in Document 0 ---");
                for (IndexableField f : doc.getFields()) {
                     System.err.println("Name: " + f.name() + " | Value: " + f.stringValue());
                }
                System.err.println("-----------------------------------");
            }

            String g = doc.get("g");
            String a = doc.get("a");

            // Fallback: Parse 'u' field if 'g' or 'a' are missing
            // Format: groupId|artifactId|version|classifier|extension
            if (g == null || a == null) {
                String u = doc.get("u");
                if (u != null) {
                    String[] parts = u.split("\\|");
                    if (parts.length >= 2) {
                        g = parts[0];
                        a = parts[1];
                    }
                }
            }

            if (g != null && a != null) {
                if (
                    g.startsWith("org.eclipse") ||
                    g.startsWith("org.apache") ||
                    g.startsWith("org.springframework") ||
                    g.startsWith("com.fasterxml.jackson") ||
                    g.startsWith("org.quartz.") ||
                    g.startsWith("org.osgi.") ||
                    g.startsWith("org.opencastproject.") ||
                    g.startsWith("org.slf4j.") ||
                    g.startsWith("org.w3c.") ||
                    g.startsWith("com.sun.") ||
                    g.contains("scala") ||
                    g.contains("gradle") ||
                    g.contains("com.lihaoyi") ||
                    g.contains("org.checkerframework") ||
                    g.contains("antlr4")
                    ) {

                    System.out.println(g + "|" + a);
                }
            }

            if (i % 5000000 == 0 && i > 0) System.err.print(".");
        }
        System.err.println("\nDone.");
        reader.close();
    }
}

