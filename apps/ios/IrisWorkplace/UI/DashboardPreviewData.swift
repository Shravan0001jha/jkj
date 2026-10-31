import Foundation

#if DEBUG
// SwiftUI previews of the dashboard: the fields the app reads from IrisWorkplaceTests/Fixtures/snapshot-v1.json
// (`features`, `notes` and the rest of `gaps` dropped). DashboardTests.testPreviewDataIsTheV1Fixture keeps them equal.
extension DashboardSnapshot {
    static let preview: DashboardSnapshot = {
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(DashboardSnapshot.self, from: Data(previewJSON.utf8))
    }()

    private static let previewJSON = #"""
{"version":1,"generatedAt":"2026-11-01T06:00:00.000Z",
"products":[
{"id":"phone","name":"Phone without the Mac","health":"no-date","committedDate":null,"forecast":{"p50":"2026-12-01","p90":"2026-12-20"},"done":9,"total":18,"startedAt":"2026-10-02T14:12:23.829Z","ageDays":29.7,"epics":["ft_mv438x2svlhtf","ft_murpqm4774jf5","ft_muk0srruh7dwv"],"weekly":{"delivered":[0,0,1,0,2,6],"bugs":[0,0,1,1,1,2]},"burnup":{"done":[0,0,1,1,3,9],"total":[0,4,7,9,13,18]}},
{"id":"smarthome","name":"Smart home","health":"on-track","committedDate":"2026-11-20","forecast":{"p50":"2026-11-10","p90":"2026-11-15"},"done":14,"total":15,"startedAt":"2026-09-25T12:37:39.269Z","ageDays":36.7,"epics":["ft_mushtk4hm47wb","ft_mutmj5j9e2bwk","ft_muygyikiohil0"],"weekly":{"delivered":[2,1,2,1,3,5],"bugs":[0,0,0,0,0,2]},"burnup":{"done":[2,3,5,6,9,14],"total":[3,4,6,8,12,15]}},
{"id":"plans","name":"Plans & credits","health":"late","committedDate":"2026-10-30","forecast":{"p50":"2026-11-24","p90":"2026-12-09"},"done":6,"total":15,"startedAt":"2026-09-29T14:19:31.884Z","ageDays":32.7,"epics":["ft_mvl76rr9byyez","ft_mvduo6e7u0mht","ft_murpvaphtk4eo"],"weekly":{"delivered":[0,0,0,0,0,6],"bugs":[0,1,0,0,0,2]},"burnup":{"done":[0,0,0,0,0,6],"total":[1,2,6,9,10,15]}},
{"id":"image","name":"Image expert","health":"delivered","committedDate":null,"forecast":{"p50":null,"p90":null},"done":6,"total":6,"startedAt":"2026-09-28T07:51:45.390Z","ageDays":33.9,"epics":["ft_mvc1qc5f5a992"],"weekly":{"delivered":[0,3,2,1,0,0],"bugs":[1,0,0,0,0,0]},"burnup":{"done":[0,3,5,6,6,6],"total":[2,4,5,6,6,6]}},
{"id":"voice","name":"Voice & wake word","health":"at-risk","committedDate":"2026-11-10","forecast":{"p50":null,"p90":null},"done":4,"total":14,"startedAt":"2026-09-28T22:14:38.769Z","ageDays":33.3,"epics":["ft_muwv4nwmor9ym","ft_mummakwyuew19"],"weekly":{"delivered":[0,1,3,0,0,0],"bugs":[0,0,3,2,1,0]},"burnup":{"done":[0,1,4,4,4,4],"total":[0,3,8,11,12,14]}},
{"id":"character","name":"Iris character","health":"on-track","committedDate":"2026-11-25","forecast":{"p50":"2026-11-17","p90":"2026-11-27"},"done":14,"total":20,"startedAt":"2026-09-26T18:58:51.859Z","ageDays":35.5,"epics":["ft_muk0zk573q8v1","ft_mulrmufpu49uj","ft_murpqm3z2r31f","ft_muv6799j4bic4","ft_mux241w6i318k"],"weekly":{"delivered":[0,1,1,0,6,6],"bugs":[0,0,0,1,2,1]},"burnup":{"done":[0,1,2,2,8,14],"total":[1,1,3,5,16,20]}},
{"id":"answers","name":"Answers & everyday help","health":"on-track","committedDate":"2026-11-14","forecast":{"p50":"2026-11-10","p90":"2026-11-15"},"done":14,"total":16,"startedAt":"2026-09-26T05:57:45.891Z","ageDays":36,"epics":["ft_mushtk3rlth1x","ft_murpqm43tv775","ft_murpqm4142xj7","ft_murpvapkve1qn"],"weekly":{"delivered":[1,0,1,1,3,8],"bugs":[0,0,1,0,0,2]},"burnup":{"done":[1,1,2,3,6,14],"total":[1,2,4,4,11,16]}},
{"id":"trust","name":"Privacy & account","health":"on-track","committedDate":"2026-12-05","forecast":{"p50":"2026-11-10","p90":"2026-11-15"},"done":13,"total":15,"startedAt":"2026-10-09T11:30:34.936Z","ageDays":22.8,"epics":["ft_murpqm45i90bf","ft_murpqm3kag9n0","ft_mv3txa3d8ls5w","ft_muz1eu3clk28n","ft_muslen71s99nw"],"weekly":{"delivered":[0,0,2,0,1,10],"bugs":[0,0,0,0,1,0]},"burnup":{"done":[0,0,2,2,3,13],"total":[0,0,2,2,9,15]}},
{"id":"launch","name":"Launch & app stores","health":"delivered","committedDate":null,"forecast":{"p50":null,"p90":null},"done":24,"total":24,"startedAt":"2026-09-26T13:30:07.317Z","ageDays":35.7,"epics":["ft_muzm1gd1i3spv","ft_mv2helkrtbms0","ft_murbmb8lyn5hv","ft_murpqm492o7ya","ft_muslen5qqi9ua","ft_muslen6fhwv48"],"weekly":{"delivered":[0,7,6,9,2,0],"bugs":[0,1,2,3,0,0]},"burnup":{"done":[0,7,13,22,24,24],"total":[3,7,16,24,24,24]}}],
"trends":{"weeks":["2026-09-21","2026-09-28","2026-10-05","2026-10-12","2026-10-19","2026-10-26"],"deliveredByProduct":{"phone":[0,0,1,0,2,6],"smarthome":[2,1,2,1,3,5],"plans":[0,0,0,0,0,6],"image":[0,3,2,1,0,0],"voice":[0,1,3,0,0,0],"character":[0,1,1,0,6,6],"answers":[1,0,1,1,3,8],"trust":[0,0,2,0,1,10],"launch":[0,7,6,9,2,0]},"bugsByProduct":{"phone":[0,0,1,1,1,2],"smarthome":[0,0,0,0,0,2],"plans":[0,1,0,0,0,2],"image":[1,0,0,0,0,0],"voice":[0,0,3,2,1,0],"character":[0,0,0,1,2,1],"answers":[0,0,1,0,0,2],"trust":[0,0,0,0,1,0],"launch":[0,1,2,3,0,0]},"bugsOpenTotal":[1,2,6,9,12,11],"medianHoursToDone":[23.7,32.3,30,25.7,27.4,31.3],"waitByCause":{"review":[1.1,8,19.6,23.1,32.1,49.1],"paused/pace-hold":[0,0.3,3.1,3.6,7.9,6.1],"budget-cap":[0,0.1,0.5,2.1,1.6,1.4],"staging-down":[0,0.1,0.3,1,1.9,1.7],"dependency":[0,3.2,8.4,19,22.4,26.6],"mac-or-device":[0,0,0.3,3.1,8.1,10.6],"unknown":[0,0,2.8,14.4,38.2,36.8],"owner-decision":[0,0,0,5.5,7.5,6.7]}},
"gaps":{"window":"30d","reviewWait":{"approval1Minutes":{"p50":132.6,"p90":223.4},"approval2Minutes":{"p50":283.3,"p90":539.7}}}}
"""#
}
#endif
