# Maven Central Alias Generation

This guide explains how to regenerate `vendor-alias.json` by mining the Maven Central index. This file maps Jar artifact names to their correct Maven Group IDs, improving identification for jars lacking embedded pom files (e.g. Eclipse OSGi bundles).

## Prerequisites

1.  Java JDK 17 or higher.
2.  Python 3.
3.  **Maven Indexer CLI**: Download `indexer-cli-7.1.6-cli.jar` (or later) from Maven Central.
4.  **Raw Index Files**: Download `nexus-maven-repository-index.gz` and `nexus-maven-repository-index.properties` from `https://repo1.maven.org/maven2/.index/`.

## Steps

### 1. Unpack the Index

Place the `.gz` and `.properties` files in a directory named `central-index`. Run the indexer tool to unpack the binary Lucene index.

```bash
curl -LO https://repo1.maven.org/maven2/org/apache/maven/indexer/indexer-cli/7.1.6/indexer-cli-7.1.6-cli.jar

mkdir central-index
cd central-index
curl -O https://repo1.maven.org/maven2/.index/nexus-maven-repository-index.gz                                                                                                              (base)
curl -O https://repo1.maven.org/maven2/.index/nexus-maven-repository-index.properties
cd ..
```

```bash
mkdir unpacked-index
java -jar indexer-cli-7.1.6-cli.jar -u -t full -i central-index -d unpacked-index
```

### 2. Extract Artifact Metadata

Compile and run the `DumpEclipse.java` utility. This program uses the Lucene libraries embedded in the `indexer-cli` jar to read the binary index and extract `groupId|artifactId` pairs for target ecosystems (Eclipse, Apache, Spring, Jackson).

**Compile:**

```bash
javac -cp indexer-cli-7.1.6-cli.jar DumpEclipse.java
```

**Run:**

```bash
# Linux/Mac
java -cp .:indexer-cli-7.1.6-cli.jar DumpEclipse unpacked-index > eclipse_artifacts.txt

# Windows
java -cp .;indexer-cli-7.1.6-cli.jar DumpEclipse unpacked-index > eclipse_artifacts.txt
```

### 3. Generate JSON Map

Run the Python script to parse the extracted text file and generate the final JSON mapping.

```bash
python generate_json.py
```

This creates `vendor-alias.json`.

## Known issues

- Does not handle relocations. Example: `org.eclipse.scout.sdk.deps` was relocated to `org.eclipse.platform`
