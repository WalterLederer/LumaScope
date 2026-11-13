#include <valhalla/tyr/actor.h>
#include <valhalla/midgard/logging.h>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <exception>
#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string make_error_response(const std::string& message) {
    boost::property_tree::ptree response;
    response.put("error", message);

    std::ostringstream stream;
    boost::property_tree::write_json(stream, response, false);
    return stream.str();
}

std::string make_ready_response() {
    boost::property_tree::ptree response;
    response.put("ready", true);

    std::ostringstream stream;
    boost::property_tree::write_json(stream, response, false);
    return stream.str();
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

        std::cerr << "[LumaScope] Valhalla initialized. Waiting for requests.\n";
        std::cout << make_ready_response() << '\n' << std::flush;

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
