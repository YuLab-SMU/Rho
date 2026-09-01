use lbug::{Connection, Database, SystemConfig, Value};

#[test]
fn ladybug_persists_graph_transactions_and_reopens() {
    assert_eq!(lbug::VERSION, "0.20.1");
    assert!(
        lbug::get_library_source() == "source"
            || lbug::get_library_source() == "external"
            || lbug::get_library_source().ends_with("/v0.20.1"),
        "unexpected Ladybug engine source: {}",
        lbug::get_library_source()
    );
    let temporary = tempfile::tempdir().unwrap();
    let database_path = temporary.path().join("evidence.lbdb");

    {
        let database = open(&database_path);
        let connection = Connection::new(&database).unwrap();
        connection
            .query(
                "CREATE NODE TABLE GraphNode(
                    node_id STRING PRIMARY KEY,
                    project_id STRING,
                    kind STRING,
                    label STRING
                )",
            )
            .unwrap();
        connection
            .query(
                "CREATE REL TABLE GraphEdge(
                    FROM GraphNode TO GraphNode,
                    edge_id STRING,
                    predicate STRING
                )",
            )
            .unwrap();

        connection.query("BEGIN TRANSACTION").unwrap();
        let mut insert_node = connection
            .prepare(
                "CREATE (:GraphNode {
                    node_id: $node_id,
                    project_id: $project_id,
                    kind: $kind,
                    label: $label
                })",
            )
            .unwrap();
        for (node_id, kind, label) in [
            ("claim:1", "claim", "Primary claim"),
            ("artifact:1", "artifact", "plot.png"),
        ] {
            connection
                .execute(
                    &mut insert_node,
                    vec![
                        ("node_id", Value::String(node_id.to_string())),
                        ("project_id", Value::String("project:local".to_string())),
                        ("kind", Value::String(kind.to_string())),
                        ("label", Value::String(label.to_string())),
                    ],
                )
                .unwrap();
        }
        let mut insert_edge = connection
            .prepare(
                "MATCH (source:GraphNode), (target:GraphNode)
                 WHERE source.node_id = $source_id AND target.node_id = $target_id
                 CREATE (source)-[:GraphEdge {
                    edge_id: $edge_id,
                    predicate: $predicate
                 }]->(target)",
            )
            .unwrap();
        connection
            .execute(
                &mut insert_edge,
                vec![
                    ("source_id", Value::String("artifact:1".to_string())),
                    ("target_id", Value::String("claim:1".to_string())),
                    ("edge_id", Value::String("edge:1".to_string())),
                    ("predicate", Value::String("supports".to_string())),
                ],
            )
            .unwrap();
        connection.query("COMMIT").unwrap();

        connection.query("BEGIN TRANSACTION").unwrap();
        connection
            .query(
                "CREATE (:GraphNode {
                    node_id: 'rolled-back',
                    project_id: 'project:local',
                    kind: 'claim',
                    label: 'Must disappear'
                })",
            )
            .unwrap();
        connection.query("ROLLBACK").unwrap();
    }

    {
        let database = open(&database_path);
        let connection = Connection::new(&database).unwrap();
        let rows = connection
            .query(
                "MATCH (source:GraphNode)-[edge:GraphEdge]->(target:GraphNode)
                 RETURN source.node_id, edge.predicate, target.node_id",
            )
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![vec![
                Value::String("artifact:1".to_string()),
                Value::String("supports".to_string()),
                Value::String("claim:1".to_string()),
            ]]
        );
        let rolled_back = connection
            .query(
                "MATCH (node:GraphNode)
                 WHERE node.node_id = 'rolled-back'
                 RETURN count(node)",
            )
            .unwrap()
            .next()
            .unwrap();
        assert_eq!(rolled_back, vec![Value::Int64(0)]);
    }
}

fn open(path: &std::path::Path) -> Database {
    Database::new(
        path,
        SystemConfig::default()
            .buffer_pool_size(64 * 1024 * 1024)
            .max_num_threads(2)
            .throw_on_wal_replay_failure(true)
            .enable_checksums(true)
            .enable_multi_writes(false),
    )
    .unwrap()
}
