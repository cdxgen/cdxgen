package corpus.services

import java.sql.{Connection, DriverManager}
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

object DataStores {
  def orders(): Connection =
    DriverManager.getConnection("jdbc:postgresql://db.internal:5432/orders", "app", sys.env.getOrElse("DB_PASSWORD", "")) // @expect datastore kind=postgresql url=jdbc:postgresql://db.internal:5432/orders

  def events(): KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka.internal:9092") // @expect datastore kind=kafka url=kafka.internal:9092
    props.put("key.serializer", classOf[StringSerializer].getName)
    props.put("value.serializer", classOf[StringSerializer].getName)
    val producer = new KafkaProducer[String, String](props) // @expect use lib=org.apache.kafka:kafka-clients
    producer.send(new ProducerRecord[String, String]("order-events", "k", "v")) // @expect outbound url=kafka:order-events client=kafka
    producer
  }
}
