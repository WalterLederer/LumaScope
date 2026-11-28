#include <valhalla/tyr/actor.h>
#include <valhalla/midgard/logging.h>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <spatialite.h>
#include <sqlite3.h>

#include <exception>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

class AdminDatabase {
public:
    explicit AdminDatabase(const std::string& path) {
        if (path.empty()) return;
        if (sqlite3_open_v2(path.c_str(), &database_, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nullptr) != SQLITE_OK) {
            const std::string message = database_ ? sqlite3_errmsg(database_) : "SQLite open failed";
            if (database_) sqlite3_close(database_);
            database_ = nullptr;
            throw std::runtime_error("Could not open Valhalla admin database: " + message);
        }
        cache_ = spatialite_alloc_connection();
        if (!cache_) {
            sqlite3_close(database_);
            database_ = nullptr;
            throw std::runtime_error("Could not allocate SpatiaLite connection cache.");
        }
        spatialite_init_ex(database_, cache_, 0);
    }

    ~AdminDatabase() {
        if (cache_) spatialite_cleanup_ex(cache_);
        if (database_) sqlite3_close(database_);
    }

    boost::property_tree::ptree lookup(double longitude, double latitude) const {
        boost::property_tree::ptree response;
        boost::property_tree::ptree areas;
        if (!database_) {
            response.put("available", false);
            response.add_child("admin_areas", areas);
            return response;
        }

        static constexpr const char* sql =
            "SELECT admin_level, name, name_en, iso_code FROM admins "
            "WHERE rowid IN (SELECT pkid FROM idx_admins_geom "
            "WHERE xmin <= ?1 AND xmax >= ?1 AND ymin <= ?2 AND ymax >= ?2) "
            "AND ST_Intersects(geom, MakePoint(?1, ?2, 4326)) ORDER BY admin_level";

        sqlite3_stmt* statement = nullptr;
        if (sqlite3_prepare_v2(database_, sql, -1, &statement, nullptr) != SQLITE_OK)
            throw std::runtime_error("Could not prepare Valhalla admin lookup: " + std::string(sqlite3_errmsg(database_)));
        sqlite3_bind_double(statement, 1, longitude);
        sqlite3_bind_double(statement, 2, latitude);

        int result = SQLITE_ROW;
        while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
            boost::property_tree::ptree area;
            area.put("admin_level", sqlite3_column_int(statement, 0));
            const auto* name = sqlite3_column_text(statement, 1);
            const auto* name_en = sqlite3_column_text(statement, 2);
            const auto* iso_code = sqlite3_column_text(statement, 3);
            if (name) area.put("name", reinterpret_cast<const char*>(name));
            if (name_en) area.put("name_en", reinterpret_cast<const char*>(name_en));
            if (iso_code) area.put("iso_code", reinterpret_cast<const char*>(iso_code));
            areas.push_back(std::make_pair("", area));
        }
        sqlite3_finalize(statement);
        if (result != SQLITE_DONE)
            throw std::runtime_error("Valhalla admin lookup failed: " + std::string(sqlite3_errmsg(database_)));

        response.put("available", true);
        response.add_child("admin_areas", areas);
        return response;
    }

private:
    sqlite3* database_ = nullptr;
    void* cache_ = nullptr;
};

std::string make_error_response(const std::string& message) {
    boost::property_tree::ptree response;
    response.put("error", message);

    std::ostringstream stream;
    boost::property_tree::write_json(stream, response, false);
    return stream.str();
}

std::string make_ready_response() {
    // Boost.PropertyTree stores values as strings and writes "true" as a
    // quoted JSON string. The TypeScript handshake requires a real boolean.
    return R"({"ready":true})";
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 1) {
        std::cerr << "Usage: valhalla_route_helper.exe < configuration-on-stdin\n";
        return 2;
    }

    try {
        // The first stdin line is the initialization envelope. The remaining
        // lines are ordinary Valhalla route requests on the same pipe.
        std::string initialization;
        if (!std::getline(std::cin, initialization) || initialization.empty()) {
            throw std::runtime_error("Missing Valhalla initialization message on stdin.");
        }

        boost::property_tree::ptree envelope;
        std::istringstream initialization_stream(initialization);
        boost::property_tree::read_json(initialization_stream, envelope);

        const auto config = envelope.get_child_optional("config");
        if (!config) {
            throw std::runtime_error("Initialization message is missing the 'config' object.");
        }

        // Keep Valhalla logging separate from the JSON stdout protocol.
        valhalla::midgard::logging::Configure({{"type", "std_err"}});

        std::cerr << "[LumaScope] Initializing Valhalla from in-memory configuration...\n";

        valhalla::tyr::actor_t actor(*config, false);
        AdminDatabase admin_database(config->get<std::string>("mjolnir.admin", ""));

        std::cerr << "[LumaScope] Valhalla initialized. Waiting for requests.\n";
        std::cout << make_ready_response() << '\n' << std::flush;

        std::string request;

        while (std::getline(std::cin, request)) {
            if (request.empty()) {
                continue;
            }

            try {
                boost::property_tree::ptree request_tree;
                std::istringstream request_stream(request);
                boost::property_tree::read_json(request_stream, request_tree);
                if (request_tree.get<std::string>("type", "") == "admin_lookup") {
                    const double latitude = request_tree.get<double>("latitude");
                    const double longitude = request_tree.get<double>("longitude");
                    if (latitude < -90.0 || latitude > 90.0 || longitude < -180.0 || longitude > 180.0)
                        throw std::runtime_error("Invalid coordinates for Valhalla admin lookup.");
                    const auto response_tree = admin_database.lookup(longitude, latitude);
                    std::ostringstream response_stream;
                    boost::property_tree::write_json(response_stream, response_tree, false);
                    std::cout << response_stream.str() << std::flush;
                } else {
                    const std::string response = actor.route(request);
                    std::cout << response << '\n' << std::flush;
                }
            }
            catch (const std::exception& ex) {
                std::cerr << "[LumaScope] Route error: " << ex.what() << '\n';
                std::cout << make_error_response(ex.what()) << '\n' << std::flush;
            }
            catch (...) {
                std::cerr << "[LumaScope] Unknown route error.\n";
                std::cout << make_error_response("Unknown route error") << '\n' << std::flush;
            }
        }

        std::cerr << "[LumaScope] Shutting down Valhalla.\n";
        actor.cleanup();
        return 0;
    }
    catch (const std::exception& ex) {
        std::cerr << "[LumaScope] Valhalla initialization error: " << ex.what() << '\n';
        std::cout << make_error_response(ex.what()) << '\n' << std::flush;
        return 1;
    }
    catch (...) {
        std::cerr << "[LumaScope] Unknown Valhalla initialization error.\n";
        std::cout << make_error_response("Unknown Valhalla initialization error") << '\n' << std::flush;
        return 1;
    }
}
