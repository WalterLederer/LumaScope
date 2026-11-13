#include <valhalla/tyr/actor.h>
#include <valhalla/midgard/logging.h>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <exception>
#include <iostream>
#include <string>
#include <sstream>

namespace {

std::string make_error_response(const std::string& message) {
    boost::property_tree::ptree response;
    response.put("error", message);

    std::ostringstream stream;
    boost::property_tree::write_json(stream, response, false);
    return stream.str();
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "Usage: valhalla_route_helper.exe <valhalla.json>\n";
        return 2;
    }

    try {
        boost::property_tree::ptree config;
        boost::property_tree::read_json(argv[1], config);

        // Keep Valhalla logging separate from the JSON stdout protocol.
        valhalla::midgard::logging::Configure({{"type", "std_err"}});

        std::cerr << "[LumaScope] Initializing Valhalla...\n";

        valhalla::tyr::actor_t actor(config, false);

        std::cerr << "[LumaScope] Valhalla initialized. Waiting for requests.\n";

        std::string request;

        while (std::getline(std::cin, request)) {
            if (request.empty()) {
                continue;
            }

            try {
                const std::string response = actor.route(request);

                std::cout << response << '\n' << std::flush;
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
        std::cerr << "[LumaScope] Valhalla initialization error: "
                  << ex.what() << '\n';
        return 1;
    }
    catch (...) {
        std::cerr << "[LumaScope] Unknown Valhalla initialization error.\n";
        return 1;
    }
}
