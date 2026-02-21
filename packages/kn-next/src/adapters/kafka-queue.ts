import type { Queue, QueueMessage } from "@opennextjs/aws/types/overrides";
import { CompressionTypes, Kafka, type Producer } from "kafkajs";

const { KAFKA_BROKER_URL, KAFKA_REVALIDATION_TOPIC, KAFKA_CLIENT_ID } =
    process.env;

// Kafka client configuration
const kafka = new Kafka({
    clientId: KAFKA_CLIENT_ID ?? "kn-next-revalidation",
    brokers: (KAFKA_BROKER_URL ?? "localhost:9092").split(","),
    retry: {
        initialRetryTime: 100,
        retries: 3,
    },
});

let producer: Producer | null = null;

async function getProducer(): Promise<Producer> {
    if (!producer) {
        producer = kafka.producer();
        await producer.connect();
    }
    return producer;
}

/**
 * Kafka Queue adapter for OpenNext ISR revalidation.
 *
 * Publishes CloudEvents to a Kafka topic which can be consumed by:
 * - Knative Eventing KafkaSource → Trigger → Revalidation Function
 * - Direct Kafka consumer
 *
 * Message format follows CloudEvents spec for Knative compatibility.
 */
const queue: Queue = {
    name: "kafka",

    async send(message: QueueMessage): Promise<void> {
        try {
            const prod = await getProducer();
            const topic = KAFKA_REVALIDATION_TOPIC ?? "next-revalidation";

            // CloudEvents formatted message for Knative Eventing compatibility
            const cloudEvent = {
                specversion: "1.0",
                type: "dev.kn-next.revalidation",
                source: "/kn-next/isr",
                id: message.MessageDeduplicationId,
                time: new Date().toISOString(),
                datacontenttype: "application/json",
                data: {
                    host: message.MessageBody.host,
                    url: message.MessageBody.url,
                    lastModified: message.MessageBody.lastModified,
                    eTag: message.MessageBody.eTag,
                },
            };

            await prod.send({
                topic,
                compression: CompressionTypes.GZIP,
                messages: [
                    {
                        key: message.MessageGroupId,
                        value: JSON.stringify(cloudEvent),
                        headers: {
                            "ce-specversion": "1.0",
                            "ce-type": "dev.kn-next.revalidation",
                            "ce-source": "/kn-next/isr",
                            "ce-id": message.MessageDeduplicationId,
                            "content-type": "application/cloudevents+json",
                        },
                    },
                ],
            });
        } catch (error) {
            console.error("[Kafka Queue] Error sending message:", error);
            throw error;
        }
    },
};

// Graceful shutdown
process.on("beforeExit", async () => {
    if (producer) {
        await producer.disconnect();
    }
});

export default queue;
